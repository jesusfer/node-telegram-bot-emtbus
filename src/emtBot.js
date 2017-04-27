// Copyright (c) 2016 Jesús Fernández <jesus@nublar.net>
// MIT License
'use strict';

const settings = require('./settings.js');
const TelegramBot = require('node-telegram-bot-api');
const EMTAPI = require('node-emtmad-bus-promise');
const _ = require('lodash');
const uuid = require('uuid');
const xml2json = require('./xml2json.js');
const debug = require('debug')('node-telegram-bot-emtbus');
const P = require('bluebird');

// TELEGRAM BOT ///////////////////////////////////////////////////////////////

const bot = new TelegramBot(settings.token, {polling: true});

// Azure Application Insights /////////////////////////////////////////////////

const appInsights = require("applicationinsights");
const instrumentationKey = _.isNil(process.env.APPINSIGHTS_INSTRUMENTATIONKEY)
    ? "testingKey"
    : process.env.APPINSIGHTS_INSTRUMENTATIONKEY;
appInsights
    .setup(instrumentationKey)
    .setAutoCollectConsole(false)
    .setAutoCollectPerformance(false)
    .setAutoCollectRequests(false)
    .setAutoCollectDependencies(false)
    .start();
const telemetryClient = appInsights.getClient(instrumentationKey);

const telemetryEvents = {
    InlineQuery: 'InlineQuery',
    QueryWithLocation: 'QueryWithLocation',
    QueryWithText: 'QueryWithText',
    RefreshQuery: 'RefreshQuery'
};

// CONSTANTS //////////////////////////////////////////////////////////////////

const xmlStops = xml2json(settings.emt_nodesxml).TABLA.DocumentElement[0].REG;
const xmlLines = xml2json(settings.emt_linesxml).TABLA.DocumentElement[0].REG;
const emptyLocation = {latitude: 0, longitude: 0};
// Properties of a stop that will be rendered in a table
const columns = ['lineId', 'destination', 'time'];

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
                console.error(error);
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
    return EMTAPI.getStopsLine(line, direction)
        .then(function (results) {
            let stops = _.get(results, 'stop', []);
            let stop = stops.find(function (stop) {
                return stop.stopId === stopId;
            });
            return {
                latitude: stop.latitude,
                longitude: stop.longitude
            };
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
*/

/*
* Since the stop objects are different in the REST API and the XML, we build
* a new object to have a consistent object across the rest of the functions.
*/
const buildStop = function (rawStop) {
    return new P(function (resolve, reject) {
        let newStop = {};
        let nodeId = _.get(rawStop, "Node[0]", -1);
        let stopId = _.get(rawStop, "stopId", -1);
        if (nodeId !== -1) {
            // Build from XML
            newStop.Id = nodeId;
            newStop.Name = _.get(rawStop, 'Name[0]', 'Nombre de la parada');
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
            newStop.Id = stopId;
            newStop.Name = _.get(rawStop, 'name', 'Nombre de la parada');
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
        } else {
            reject('Bad raw stop');
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
        }
        if (location.latitude !== 0 || location.longitude !== 0) {
            debug('Query contains location');
            isLocationQuery = true;
            telemetryClient.trackEvent(telemetryEvents.QueryWithLocation);
        }
        if ((isEmptyQuery && !isLocationQuery) || isNaNQuery) {
            debug(`Query is empty and the user didn't send a location`);
            reject(`Query is empty and the user didn't send a location`);
        }

        let foundByQuery = [];
        let stopsFound = [];

        if (!isEmptyQuery) {
            debug('Query is not empty, find a matching stop in the XML');
            telemetryClient.trackEvent(telemetryEvents.QueryWithText);
            let findFunction = function (o) {
                return _.startsWith(o.Node, query);
            };
            if (exact) {
                findFunction = function (o) {
                    return o.Node[0] === query;
                };
            }
            // Look for stops that start with that number in the DB
            foundByQuery = _.slice(xmlStops.filter(findFunction), 0, settings.maxResults);
        }

        debug('Calling EMT API to get stops by location');
        EMTAPI.getStopsFromLocation(location, settings.searchRadius)
            .then(function (stops) {
                // Got some strop from the location, convert the type
                stops = _.slice(stops, 0, settings.maxResults);
                return Promise.all(_.map(stops, buildStop));
            })
            .then(function (stopsByLocation) {
                // Now we can add the converted to the results
                debug(`Built by location: ${stopsByLocation.length}`);
                stopsFound = _.concat(stopsFound, stopsByLocation);
            })
            .then(function () {
                // Convert the stops from the query
                return Promise.all(_.map(foundByQuery, buildStop));
            })
            .then(function (stopsByQuery) {
                debug(`Built by query ${stopsByQuery.length}`);
                if (stopsByQuery.length > 0) {
                    // If there are stops from the query, we don't want by location
                    stopsFound = stopsByQuery;
                }
            })
            .then(function () {
                // We now may have a list of stops, return then
                if (stopsFound.length === 0) {
                    // TODO We may want to return an error?
                    debug('No stops found');
                }
                debug(`Stops found: ${stopsFound.length}`);
                resolve(_.slice(stopsFound, 0, settings.maxResults));
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
        let arriving = "Sin estimaciones";
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
        let url = `https://www.google.com/maps/@${stop.position.latitude},${stop.position.longitude},19z`;
        const content = `*${stop.Id}* ${stop.Name}
${arriving}

[¿Dónde está la parada?](${url})`;
        const result = {type: 'article'};
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
                    text: "Actualizar",
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
            bot.answerInlineQuery(inlineId, results, {cache_time: 10});
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
                                text: "Actualizar",
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

module.exports = bot;
