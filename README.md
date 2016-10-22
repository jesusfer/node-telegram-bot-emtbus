# node-telegram-bot-emtbus

[![Code Climate](https://codeclimate.com/github/jesusfer/node-telegram-bot-emtbus/badges/gpa.svg)](https://codeclimate.com/github/jesusfer/node-telegram-bot-emtbus)

A Telegram bot to get bus arrival estimations in Madrid, Spain.

It works in inline mode. Write `@emtbusbot <stop_number>` in any Telegram chat
and you'll get an estimation of the arrinving times to that bus stop.

If your Telegram client supports sending your location and you approve those
permissions, if you don't send a bus stop number, you'll be shown the closest
stops to your position.

The bot uses the public API of the EMT at http://opendata.emtmadrid.es

## Boring Legal Stuff

MIT License

Copyright (c) 2016 Jesús Fernández

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
