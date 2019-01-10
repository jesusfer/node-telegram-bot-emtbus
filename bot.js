// Copyright (c) 2018 Jesús Fernández <jesus@nublar.net>
// MIT License

'use strict';

let bot = require('./src/emtBot');

console.log('Bot started: ' + (new Date()).toUTCString());

function handler() {
    console.log('Bot exiting: ' + (new Date()).toUTCString());
    bot.stopPolling()
        .then(function () {
            process.exit();
        });
}

process.on('SIGINT', handler);
process.on('SIGTERM', handler);
process.on('exit', handler);
