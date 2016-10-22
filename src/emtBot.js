// Copyright (c) 2016 Jesús Fernández <jesus@nublar.net>
// MIT License

'use strict';

const settings = require('./settings.js');
const TelegramBot = require('node-telegram-bot-api');
const EMTAPI = require('node-emtmad-bus-promise');
const _ = require('lodash');
const uuid = require('node-uuid');
const xml2json = require('./xml2json.js');
const debug = require('debug')('emtBot');
const P = require('bluebird');

// TELEGRAM BOT ///////////////////////////////////////////////////////////////

const bot = new TelegramBot(settings.token, {polling: true});

// Init EMT API ///////////////////////////////////////////////////////////////

const xmlStops = xml2json(settings.emt_nodesxml).TABLA.DocumentElement[0].REG;
const xmlLines = xml2json(settings.emt_linesxml).TABLA.DocumentElement[0].REG;
const searchRadius = 200;

EMTAPI.initAPICredentials(settings.emt_app_id, settings.emt_passkey);

// UTILS //////////////////////////////////////////////////////////////////////

const findXmlLine = function (lineId) {
    return xmlLines.find(function (o) {
        return o.Line[0] === _.padStart(lineId, 3, 0);
    });
};

// Render a bus stop
const getArrivingBuses = function (stop) {
    // Return a promise
    return new P(function (resolve) {
        EMTAPI.getIncomingBusesToStop(stop.Id).then(function (arriving) {
            stop.arriving = arriving;
            resolve(stop);
        }).catch(function (error) {
            resolve(`Error: ${error}`);
        });
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
    postalAddress: 'Av.deAbrantes,
    106',
    longitude: -3.7324823992585,
    latitude: 40.377653538528,
    line: [Object]
}
*/
const buildStop = function (rawStop) {
    return new P(function (resolve, reject) {
        let newStop = {};
        let nodeId = _.get(rawStop, "Node[0]", -1);
        let stopId = _.get(rawStop, "stopId", -1);
        if (nodeId !== -1) {
            // debug('Build from XML');
            newStop.Id = nodeId;
            newStop.Name = _.get(rawStop, 'Name[0]', 'Nombre de la parada');
            let rawLines = _.get(rawStop, 'Lines[0]', '').split(' ');
            newStop.Lines = _.map(rawLines, function (rawLine) {
                let temp = rawLine.split('/');
                let label = findXmlLine(temp[0]).Label[0];
                if (temp[1] === '1') {
                    return `${label} ida`;
                } else {
                    return `${label} vuelta`;
                }
            });
        } else if (stopId !== -1) {
            //debug(rawStop);
            // debug('Build from API');
            newStop.Id = stopId;
            newStop.Name = _.get(rawStop, 'name', 'Nombre de la parada');
            newStop.Lines = _.map(_.concat(rawStop.line, []), function (line) {
                let label = line.line;
                if (line.direction === 'A') {
                    return `${label} ida`;
                } else {
                    return `${label} vuelta`;
                }
            });
        } else {
            reject('Bad raw stop');
        }
        resolve(newStop);
    });
};

const logErrors = function (query, id, error) {
    console.error(`Inline Query with error: ${query}`);
    console.error(error);
    bot.answerInlineQuery(id, []);
};

// COMMANDS ///////////////////////////////////////////////////////////////////

const helpText =
        'This bot is intended to be used in inline mode, just type ' +
        '@emtbusbot and a bus stop number to get an estimation.';

bot.onText(/\/start.*/, function (msg) {
    bot.sendMessage(msg.from.id, helpText);
});

bot.onText(/\/help.*/, function (msg) {
    bot.sendMessage(msg.from.id, helpText);
});

// INLINE MODE ////////////////////////////////////////////////////////////////

const findStops = function (query, location) {
    return new P(function (resolve, reject) {
        debug(`Input query: ${query}`);
        debug(`Input location: ${location.latitude} ${location.longitude}`);
        let isEmptyQuery = false;
        let isLocationQuery = false;
        let isNaNQuery = false;

        if (query.length === 0) {
            debug('Empty query');
            isEmptyQuery = true;
            // Query must be a number
            if (!isEmptyQuery && isNaN(+query)) {
                debug('Query is not a number');
                isNaNQuery = true;
            }
        }
        if (location.latitude !== 0 || location.longitude !== 0) {
            debug('Query contains location');
            isLocationQuery = true;
        }
        if (isEmptyQuery && !isLocationQuery) {
            debug(`Query is empty and the user didn't send a location`);
            reject(`Query is empty and the user didn't send a location`);
        }

        let foundByQuery = [];
        let stopsFound = [];

        if (!isEmptyQuery) {
            debug('Query is not empty, find a matching stop in the XML');
            // Look for stops that start with that number in the DB
            foundByQuery = _.slice(xmlStops.filter(function (o) {
                return _.startsWith(o.Node, query);
            }), 0, settings.maxResults);
        }

        debug('Calling EMT API to get stops by location');
        EMTAPI.getStopsFromLocation(location, searchRadius)
            .then(function (stops) {
                return Promise.all(_.map(stops, buildStop));
            })
            .then(function (stopsByLocation) {
                debug(`Built by location: ${stopsByLocation.length}`);
                stopsFound = _.concat(stopsFound, stopsByLocation);
            })
            .then(function () {
                return Promise.all(_.map(foundByQuery, buildStop));
            })
            .then(function (stopsByQuery) {
                debug(`Built by query ${stopsByQuery.length}`);
                if (stopsByQuery.length > 0) {
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
            });
    });
};

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
    const location = _.get(request, 'location', {latitude: 0, longitude: 0});
    debug(`New inline query: ${query}`);

    findStops(query, location)
        .then(function (stops) {
            debug(`We got ${stops.length} stops`);
            return P.all(_.map(stops, getArrivingBuses));
        })
        .then(function (stops) {
            stops = _.reject(stops, function (result) {
                return _.isString(result);
            });
            let results = _.map(stops, function (stop) {
                let arriving = "Sin estimaciones";
                if (stop.arriving.length > 0) {
                    arriving = _.join(_.map(stop.arriving, function (e) {
                        let time = e.busTimeLeft;
                        switch (time) {
                        case 999999:
                            time = '+20 min';
                            break;
                        case 0:
                            time = 'En parada';
                            break;
                        default:
                            time = _.round(time / 60) + ' min';
                        }
                        return `${e.lineId} ${e.destination} ${time}`;
                    }), '\r\n');
                }
                const content = `*${stop.Id}* ${stop.Name}
${arriving}`;
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
                return result;
            });
            debug(`Final results: ${results.length}`);
            bot.answerInlineQuery(inlineId, results, {cache_time: 10});
        }, function (error) {
            console.log(error);
        })
        .catch(function (error) {
            logErrors(request.query, inlineId, error);
        });
    // logErrors(request.query, inlineId, 'No results');
});

module.exports = bot;
