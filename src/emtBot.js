// Copyright (c) 2018 Jesús Fernández <jesus@nublar.net>
// MIT License
'use strict';

const settings = require('./settings.js');
const TelegramBot = require('node-telegram-bot-api');
// FUTURE: seems like a better library https://github.com/Lorengamboa/EMT-library
const EMTAPI = require('node-emtmad-bus-promise');
const _ = require('lodash');
const uuid = require('uuid');
const xml2json = require('./xml2json.js');
const debug = require('debug')('bot');
const debugCache = require('debug')('bot-cache');
const debugBuild = require('debug')('bot-build');
const P = require('bluebird');
const utm = require('utm');

// TELEGRAM BOT ///////////////////////////////////////////////////////////////

const bot = new TelegramBot(settings.token, { polling: true });

// Azure Application Insights /////////////////////////////////////////////////

const appInsights = require('applicationinsights');
const instrumentationKey = _.isNil(process.env.APPINSIGHTS_INSTRUMENTATIONKEY)
    ? 'testingKey'
    : process.env.APPINSIGHTS_INSTRUMENTATIONKEY;

appInsights
    .setup(instrumentationKey)
    .setAutoCollectConsole(false)
    .setAutoCollectPerformance(false)
    .setAutoCollectRequests(false)
    .setAutoCollectDependencies(false)
    .start();
const telemetryClient = appInsights.defaultClient;

const telemetryEvents = {
    InlineQuery: 'InlineQuery',
    QueryWithLocation: 'QueryWithLocation',
    QueryWithText: 'QueryWithText',
    RefreshQuery: 'RefreshQuery'
};

// CONSTANTS //////////////////////////////////////////////////////////////////

const xmlLines = xml2json(settings.emt_linesxml).TABLA.DocumentElement[0].REG;
const emptyLocation = { latitude: 0, longitude: 0 };
const utmXoffset = -110;
const utmYoffset = -197;

// Properties of a stop that will be rendered in a table
const columns = ['lineId', 'destination', 'time'];

// CACHES //////////////////////////////////////////////////////////////////////
/**
 * Cache of Stop objects indexed by their ID.
 */
var stopCache = {};

function buildStopCache() {
    debugCache('Stop cache: building...');
    const maxId = 6500;
    let firstId = 1,
        step = 100,
        timeout = 0,
        timeoutStep = 2000;
    while (firstId < maxId) {
        loadStopBatch(firstId, firstId + step, timeout);
        timeout += timeoutStep;
        firstId += step;
    }
    debugCache('Stop cache: complete');
}

function loadStopBatch(first, last, timeout) {
    setTimeout(function () {
        EMTAPI.getNodesLines(_.range(first, last))
            .then(function (results) {
                debugCache(`Stop cache: results from ${first} to ${last}`);
                return Promise.all(_.map(results, buildStop));
            })
            .then(function (stops) {
                _.map(stops, function (item) {
                    _.set(stopCache, item.Id, item);
                });
            })
            .catch(function (err) {
                debugCache(`Stop cache: Error: ${err} ${err.stack}`);
                loadStopBatch(first, last, 0);
            });
    }, timeout);
}

buildStopCache();


// UTILS //////////////////////////////////////////////////////////////////////
/**
* Look for a bus line in the Lines XML using the line Id, which is a 3 digit
* code that identifies the line, but it's not the same as the label the line has
* For example, the code 516 is the line N16.
*/
const findXmlLine = function (lineId) {
    return xmlLines.find(function (o) {
        return o.Line[0] === _.padStart(lineId, 3, 0);
    });
};

/**
* Get the buses arriving to this stop and set the arriving property.
* Returns a Promise object.
*/
const getArrivingBuses = function (stop) {
    // Return a promise
    return new P(function (resolve) {
        EMTAPI.getIncomingBusesToStop(stop.Id)
            .then(function (arriving) {
                arriving = _.concat([], arriving);
                stop.arriving = _.map(arriving, function (bus) {
                    // Pretty print the arriving time
                    let time = bus.busTimeLeft;
                    let timeMin = _.floor(time / 60);
                    if (time === 0 || timeMin === 0) {
                        time = '<<<';
                    } else if (time === 999999) {
                        time = '+20';
                    } else {
                        time = timeMin + '';
                    }
                    _.set(bus, 'time', time);
                    return bus;
                });
                resolve(stop);
            })
            .catch(function (error) {
                debug(`Error: ${error}`);
                resolve(`Error: ${error}`);
            });
    });
};

/**
* In order to print the arriving times in a table-like fashion, we need to know
* in advance the max width of each column's text so that we can pad each column
* with spaces according to their width.
*/
const getColumnWidths = function (stop, columns) {
    let format = {};
    _.forEach(stop.arriving, function (bus) {
        // bus is an arriving bus
        _.forEach(columns, function (col) {
            // col is a column that will be printed
            let currentMax = _.get(format, col, 0);
            // Enforce a max column width of so that the line is not too long
            // Helps reading the results better in mobile phones.
            let current = Math.min(_.get(bus, col, 0).length, settings.maxColumnWidth);
            let max = Math.max(currentMax, current);
            _.set(format, col, max);
        });
    });
    return format;
};

const getStopLocation = function (stopId, line, direction) {
    debug(`Getting location for stop ${stopId} with line ${line} and direction ${direction}`);
    let cachedStop = stopCache.filter(function (o) {
        return o.Node == stopId;
    })[0];

    if (cachedStop) {
        debug(`Found cached stop for ${stopId}`);
        let x, y, location;
        try {
            x = parseInt(cachedStop.PosxNode[0]) + utmXoffset;
            y = parseInt(cachedStop.PosyNode[0]) + utmYoffset;
            location = utm.toLatLon(x, y, 30, 'T');
        }
        catch (error) {
            return new P(function (resolve, reject) {
                reject(Error('Could not transform UTM to LatLon'));
            });
        }
        debug(`Cached location: ${location.latitude},${location.longitude}`);
        return new P(function (resolve) {
            resolve(location);
        });
    }
    return EMTAPI.getStopsLine(line, direction)
        .then(function (results) {
            let stops = _.get(results, 'stop', []);
            let stop = stops.find(function (stop) {
                return stop.stopId === stopId;
            });
            let location = {
                latitude: stop.latitude,
                longitude: stop.longitude
            };
            debug(`Location for stop ${stopId} and line ${line}/${direction}: ${location.latitude},${location.longitude}`);
            return location;
        })
        .catch(function (error) {
            console.error(`Error: ${error}`);
        });
};

/* Example of a stop object from the XML file
{
    Node: ['4230'],
    PosxNode: ['447148,3'],
    PosyNode: ['4474608'],
    Name: ['HNOS.GARCIANOBLEJAS-PZA.DEALSACIA'],
    Lines: ['70/1']
}
Stop object from API
{
    stopId: '2443',
    name: 'AV.ABRANTES-PZA.LASMENINAS',
    postalAddress: 'Av.deAbrantes, 106',
    longitude: -3.7324823992585,
    latitude: 40.377653538528,
    line: [Object]
}

From API Node:
{ Wifi: '0',
  node: 1,
  name: 'Avenida Valdemarín-Blanca de Castilla',
  lines: [ '', '161/1/1' ],
  latitude: 40.47004454502,
  longitude: -3.782887713069 }
*/

/*
* Since the stop objects are different in the REST API and the XML, we build
* a new object to have a consistent object across the rest of the functions.
*/
const buildStop = function (rawStop) {
    return new P(function (resolve, reject) {
        let newStop = {};
        let nodeId = _.get(rawStop, 'Node[0]', -1);
        let stopId = _.get(rawStop, 'stopId', -1);
        let node = _.get(rawStop, 'node', -1);
        if (nodeId !== -1) {
            // Build from XML
            debugBuild(`StopBuild->Building stop from XML (${nodeId})`);
            newStop.Id = nodeId;
            newStop.Name = _.get(rawStop, 'Name[0]', `Parada ${newStop.Id}`);
            let rawLines = _.get(rawStop, 'Lines[0]', '').split(' ');
            let aLine = '';
            newStop.Lines = _.map(rawLines, function (rawLine) {
                aLine = rawLine;
                let temp = rawLine.split('/');
                let label = findXmlLine(temp[0]).Label[0];
                if (temp[1] === '1') {
                    return `${label} ida`;
                } else {
                    return `${label} vuelta`;
                }
            });
            getStopLocation(nodeId, aLine.split('/')[0], aLine.split('/')[1])
                .then(function (position) {
                    newStop.position = position;
                    resolve(newStop);
                });
        } else if (stopId !== -1) {
            // Build from API
            debugBuild(`StopBuild->Building stop from API:Stop (${stopId})`);
            newStop.Id = stopId;
            newStop.Name = _.get(rawStop, 'name', `Parada ${newStop.Id}`);
            newStop.Lines = _.map(_.concat(rawStop.line, []), function (line) {
                let label = line.line;
                if (line.direction === 'B') {
                    return `${label} ida`;
                } else {
                    return `${label} vuelta`;
                }
            });
            newStop.position = {
                latitude: rawStop.latitude,
                longitude: rawStop.longitude
            };
            resolve(newStop);
        } else if (node !== -1) {
            // Build from API NodesLines
            debugBuild(`StopBuild->Building stop from API:Node (${node})`);
            newStop.Id = node;
            newStop.Name = _.get(rawStop, 'name', `Parada ${newStop.Id}`);
            let rawLines = _.get(rawStop, 'lines', '').filter(x => x.length > 0);
            newStop.Lines = _.map(rawLines, function (rawLine) {
                let temp = rawLine.split('/');
                // FIX: there may be missing lines in the XML too so this has to be built in some other way (API call)
                let label = '';
                try {
                    label = findXmlLine(temp[0]).Label[0];
                    if (temp[1] === '1') {
                        return `${label} ida`;
                    } else {
                        return `${label} vuelta`;
                    }
                }
                catch (err) {
                    debugBuild(`StopBuild->Line '${rawLine}' not found`);
                }
            });
            newStop.position = {
                latitude: rawStop.latitude,
                longitude: rawStop.longitude
            };
            resolve(newStop);
        } else {
            debugBuild('Bad raw stop');
            reject('StopBuild->Bad raw stop');
        }
    });
};

const logErrors = function (query, id, error) {
    console.error(`Inline Query with error: ${query}`);
    console.error(error);
    bot.answerInlineQuery(id, []);
};

/**
* Given a query text and a location object, both coming from the user, find
* a list of stops whose stop ID start with the query of the user or that are
* close to the location of the user.
* Returns a Promise object that fulfills to an array of Stops.
*/
const findStops = function (query, location, exact = false) {
    return new P(function (resolve, reject) {
        let isEmptyQuery = false;
        let isLocationQuery = false;
        let isNaNQuery = false;

        if (query.length === 0) {
            debug('Empty query');
            isEmptyQuery = true;
        }
        // Query must be a number
        if (!isEmptyQuery && isNaN(+query)) {
            debug('Query is not a number');
            isNaNQuery = true;
            isEmptyQuery = true;
        }
        if (location.latitude !== 0 || location.longitude !== 0) {
            debug('Query contains location');
            isLocationQuery = true;
            telemetryClient.trackEvent(telemetryEvents.QueryWithLocation);
        }
        if ((isEmptyQuery && !isLocationQuery) || isNaNQuery) {
            debug('Query is empty and the user didn\'t send a location');
            return reject('Query is empty and the user didn\'t send a location');
        }

        let foundByQuery = [];
        let stopsFound = [];

        if (!isEmptyQuery) {
            debug('Query is not empty, find a matching stop in the cache');
            telemetryClient.trackEvent(telemetryEvents.QueryWithText);
            let findFunction = function (o) {
                return _.startsWith(o, query);
            };
            if (exact) {
                findFunction = function (o) {
                    return o == query;
                };
            }
            // Look for stops that start with that number in the cache
            foundByQuery = _.slice(Object.keys(stopCache).filter(findFunction), 0, settings.maxResults);
            if (foundByQuery.length > 0) {
                // There was a query that matched some stops so return these
                return resolve(Promise.all(_.map(foundByQuery, id => stopCache[id])));
            }
            else {
                debug('The stop is not in the cache!!!');
            }
        }

        debug('Query was empty, matching by location');
        return EMTAPI.getStopsFromLocation(location, settings.searchRadius)
            .then(function (stops) {
                // Got some stops with the location, convert the type and limit results
                stops = _.slice(stops, 0, settings.maxResults);
                return Promise.all(_.map(stops, buildStop));
            })
            .then(function (stopsByLocation) {
                // Now we can add the converted to the results
                debug(`Stops found with location: ${stopsByLocation.length}`);
                resolve(_.concat(stopsFound, stopsByLocation));
            })
            .catch(function (error) {
                telemetryClient.trackException(error);
            });
    });
};

/**
* We want to format the estimations in a table that it's easier to read
* We pad the column text with spaces and render each line with a monospace font
*/
const renderStop = function (stop) {
    return new P(function (resolve) {
        let arriving = 'Sin estimaciones';
        if (stop.arriving.length > 0) {
            let widths = getColumnWidths(stop, columns);
            arriving = _.join(_.map(stop.arriving, function (e) {
                // Build the bus arriving line, padding the columns as needed
                let keys = _.keys(widths);
                let s = _.map(keys, function (w) {
                    let value = _.get(e, w, '');
                    value = _.truncate(value, {
                        length: settings.maxColumnWidth
                    });
                    value = _.padEnd(value, widths[w], ' ');
                    return value;
                });
                s = '`' + _.join(s, ' ') + '`';
                return s;
            }), '\r\n');
        }
        let mapa = '';
        if (stop.position != undefined) {
            let url = `https://www.google.com/maps/@${stop.position.latitude},${stop.position.longitude},19z`;
            mapa = `

[¿Dónde está la parada?](${url})`;
        }
        const content = `*${stop.Id}* ${stop.Name}
${arriving}${mapa}`;
        const result = { type: 'article' };
        result.id = uuid.v4();
        result.title = `${stop.Id} - ${stop.Name}`;
        result.input_message_content = {
            message_text: content,
            parse_mode: 'Markdown',
            disable_web_page_preview: true
        };
        result.description = 'Líneas: ' + _.join(stop.Lines, ', ');
        result.thumb_url = settings.result_thumb;
        result.reply_markup = {
            inline_keyboard: [[
                {
                    text: 'Actualizar',
                    callback_data: `refresh:${stop.Id}`
                }
            ]]
        };
        resolve(result);
    });
};

// COMMANDS ///////////////////////////////////////////////////////////////////

const helpText =
    'This bot is intended to be used in inline mode, just type ' +
    '@emtbusbot and a bus stop number to get an estimation.' +
    '\r\nIf you allow your Telegram client to send your location, ' +
    'you will be shown a list of the bus stops closer to you.';

bot.onText(/\/start.*/, function (msg) {
    bot.sendMessage(msg.from.id, helpText);
});

bot.onText(/\/help.*/, function (msg) {
    bot.sendMessage(msg.from.id, helpText);
});

// TELEGRAM INLINE MODE ////////////////////////////////////////////////////////
/*
Arriving example
{
    stopId: 2441,
    lineId: '47',
    isHead: 'False',
    destination: 'CARABANCHELALTO',
    busId: '8753',
    busTimeLeft: 693,
    busDistance: 2831,
    longitude: -3.7001946964466,
    latitude: 40.387599946339,
    busPositionType: 1
}
*/
bot.on('inline_query', function (request) {
    const inlineId = request.id;
    const query = request.query.trim();
    const location = _.get(request, 'location', emptyLocation);
    debug(`New inline query: ${query}`);
    debug(`Location: ${location.latitude} ${location.longitude}`);

    telemetryClient.trackEvent(telemetryEvents.InlineQuery);

    findStops(query, location)
        .then(function (stops) {
            // Once we have some stops, find the buses arriving to them
            debug(`We got ${stops.length} stops`);
            return P.all(_.map(stops, getArrivingBuses));
        })
        .then(function (stops) {
            // Once we have the stop with the arriving buses, build the results
            // we are going to return to Telegram
            stops = _.reject(stops, function (result) {
                // If the result is a String, then an error ocurred
                return _.isString(result);
            });
            return P.all(_.map(stops, renderStop));
        })
        .then(function (results) {
            debug(`Final results: ${results.length}`);
            bot.answerInlineQuery(inlineId, results, { cache_time: 10 });
        })
        .catch(function (error) {
            console.error(error);
            telemetryClient.trackException(error);
        });
    // logErrors(request.query, inlineId, 'No results');
});

const processRefresh = function (request, stopId) {
    if (_.isNaN(+stopId)) {
        debug('Bad refresh stopId');
        return;
    }
    let answerText = 'Actualizando...';
    // TODO: The method signature answerCallbackQuery(callbackQueryId, text, showAlert) has been deprecated since v0.27.1
    bot.answerCallbackQuery(request.id, answerText);

    // This is basically the same as in the inline query
    findStops(stopId, emptyLocation, true)
        .then(function (stops) {
            if (stops.length !== 1) {
                return P.reject('Error: more than one stop in refresh');
                // This is a refresh, we should never get more than one result
            }
            return stops[0];
        })
        .then(getArrivingBuses)
        .then(function (stop) {
            if (_.isString(stop)) {
                return P.reject('Error: getting arriving buses');
            }
            return stop;
        })
        .then(renderStop)
        .then(function (result) {
            bot.editMessageText(
                result.input_message_content.message_text,
                {
                    inline_message_id: request.inline_message_id,
                    parse_mode: 'Markdown',
                    reply_markup: {
                        inline_keyboard: [[
                            {
                                text: 'Actualizar',
                                callback_data: `refresh:${stopId}`
                            }
                        ]]
                    }
                }
            );
        })
        .catch(function (error) {
            console.error(error);
            telemetryClient.trackException(error);
        });
};

bot.on('callback_query', function (request) {
    debug('New CallbackQuery');
    const data = _.get(request, 'data', 0);
    debug(`Callback query data: ${data}`);
    try {
        const operation = data.split(':')[0];
        switch (operation) {
            case 'refresh':
                telemetryClient.trackEvent(telemetryEvents.RefreshQuery);
                processRefresh(request, data.split(':')[1]);
                break;
            default:
                bot.answerCallbackQuery(request.id);
        }
    } catch (error) {
        console.error(`Bad callback data: ${error}`);
        bot.answerCallbackQuery(request.id);
    }
});

// FUTURE: Act on use sending a location
// bot.on('location', (msg) => {
//     console.log(msg.location.latitude);
//     console.log(msg.location.longitude);
// });

module.exports = bot;
