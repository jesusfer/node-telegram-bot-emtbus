// Copyright (c) 2016 Jesús Fernández <jesus@nublar.net>
// MIT License

const settings = {
    token: process.env.TELEGRAM_BOT_TOKEN,

    maxResults: 6, // 50 is the maximum allowed by Telegram

    emt_app_id: process.env.EMT_APP_ID,
    emt_passkey: process.env.EMT_PASSKEY,

    emt_linesxml: './data/Lines.xml',
    emt_nodesxml: './data/NodesLines.xml',

    result_thumb: 'http://i.imgur.com/IG5PB4z.png'
};

module.exports = settings;
