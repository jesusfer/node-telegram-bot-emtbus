// Copyright (c) 2016 Jesús Fernández <jesus@nublar.net>
// MIT License

'use strict';

const fs = require('fs');
const xml2js = require('xml2js');

const xml2json = function (filePath) {
    let json;
    try {
        let fileData = fs.readFileSync(filePath, 'utf-8');
        xml2js.parseString(fileData, function (err, result) {
            json = result;
        });
        return json;
    } catch (ex) {
        console.log(ex);
    }
};

module.exports = xml2json;