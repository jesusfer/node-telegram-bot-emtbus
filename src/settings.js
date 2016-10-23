// Copyright (c) 2016 Jesús Fernández <jesus@nublar.net>
// MIT License

const settings = {
    token: process.env.TELEGRAM_BOT_TOKEN,

    maxResults: 6, // 50 is the maximum allowed by Telegram

    emt_linesxml: './data/Lines.xml',
    emt_nodesxml: './data/NodesLines.xml',

    result_thumb: 'http://i.imgur.com/IG5PB4z.png',
	// Max column width for the results table
	// For small screen phones it's still too much
    maxColumnWidth: 18
};

module.exports = settings;
