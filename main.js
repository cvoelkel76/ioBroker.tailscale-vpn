'use strict';

/*
 * Created with @iobroker/create-adapter v2.6.5
 */

// The adapter-core module gives you access to the core ioBroker functions
// you need to create an adapter
const utils = require('@iobroker/adapter-core');
const axios = require('axios');
const { CookieJar } = require('tough-cookie');
const { HttpsCookieAgent } = require('http-cookie-agent/http');
const qs = require('qs');

// Load your modules here, e.g.:
// const fs = require("fs");

class TailscaleVpn extends utils.Adapter {

    /**
     * @param {Partial<utils.AdapterOptions>} [options={}]
     */
    constructor(options) {
        super({
            ...options,
            name: 'tailscale-vpn',
        });
        this.on('ready', this.onReady.bind(this));
        this.on('stateChange', this.onStateChange.bind(this));
        // this.on('objectChange', this.onObjectChange.bind(this));
        // this.on('message', this.onMessage.bind(this));
        this.on('unload', this.onUnload.bind(this));
        this.apiUrl = 'https://api.tailscale.com/api/v2';
        this.session = {};
        const jar = new CookieJar();
        this.requestClient = axios.create({
            httpsAgent: new HttpsCookieAgent({
                rejectUnauthorized: false,
                cookies: { jar },
            }),
        });
    }

    /**
     * Is called when databases are connected and adapter received configuration.
     */
    async onReady() {
        // Initialize your adapter here

        // Reset the connection indicator during startup
        this.setState('info.connection', false, true);

        if (!this.config.tailnet) {
            this.log.info('Tailnet ID not provided. Set Tailnet to default "-"');
            this.config.tailnet = '-';
        }

        this.log.info('Login to Tailscale API '+ this.apiUrl);
        await this.login();

        if (this.session.access_token) {
            await this.getTailnetDevices();

            this.updateInterval = setInterval(async () => {
                await this.updateTailscaleData();
            }, this.config.interval * 1000);
        }

        this.refreshTokenInterval = setInterval(
            () => {
                this.refreshToken();
            },
            3600 * 1000,
        );

    }

    async login() {
        await this.requestClient({
            method: 'post',
            url: `${this.apiUrl}/oauth/token`,
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
            },
            data: qs.stringify ({
                client_id: this.config.clientid,
                client_secret: this.config.secret,
            })
        })
            .then((res) => {
                if (res.data && res.data.access_token) {
                    this.log.info('Login successful');
                    this.session = res.data;
                    this.setState('info.connection', true, true);
                } else {
                    this.log.error('Login failed: ' + JSON.stringify(res.data));
                    return;
                }
            })
            .catch((error) => {
                this.log.error(error);
                this.log.error('Login failed');
                error.response && this.log.error(JSON.stringify(error.response.data));
            });
    }

    async refreshToken() {
        this.log.debug('Refresh token');
        await this.login();
    }

    async getTailnetDevices() {
        await this.requestClient({
            method: 'get',
            url: `${this.apiUrl}/tailnet/${this.config.tailnet}/devices?fields=all`,
            headers: {
                Authorization: this.session.token_type + ' ' + this.session.access_token,
            },
        })
            .then(async (res) => {
                if (res.data.devices) {
                    this.log.info('found ' + res.data.devices.length + ' devices in tailnet "' + this.config.tailnet + '"');

                    await this.setObjectNotExistsAsync('devices', {
                        type: 'folder',
                        common: {
                            name: 'devices',
                        },
                        native: {},
                    });

                    for (const device of res.data.devices) {
                        const id = 'devices.' + device.id;
                        const name = device.name;
                        await this.setObjectNotExistsAsync(id, {
                            type: 'device',
                            common: {
                                name: name,
                            },
                            native: {},
                        });

                        await this.json2iob_lite(device, id);

                    }
                }
            })
            .catch((error) => {
                this.log.error(error);
                error.response && this.log.error(JSON.stringify(error.response.data));
            });
    }

    async json2iob_lite(data, key)  {

        for (const item of Object.keys(data)) {

            if(typeof data[item] == 'object') {
                await this.setObjectNotExistsAsync(key + '.' + item, {
                    type: 'channel',
                    common: {
                        name: item,
                    },
                    native: {},
                });

                if (data[item]) {
                    this.json2iob_lite (data[item], key + '.' + item);
                }

            } else {

                let state_role = 'value';

                if (typeof data[item] == 'boolean') {
                    state_role = 'indicator';
                }

                this.setObjectNotExists(key + '.' + item, {
                    type: 'state',
                    common: {
                        name: item,
                        type: typeof data[item],
                        role: state_role,
                        read: true,
                        write: false,
                    },
                    native: {},
                });

                this.setState(key + '.' + item, data[item], true);
            }

        }
    }

    async updateTailscaleData() {
        // on hold

    }

    /**
     * Is called when adapter shuts down - callback has to be called under any circumstances!
     * @param {() => void} callback
     */
    onUnload(callback) {
        try {
            this.setState('info.connection', false, true);
            this.refreshTokenInterval && clearInterval(this.refreshTokenInterval);

            callback();
        } catch (e) {
            callback();
        }
    }

    // If you need to react to object changes, uncomment the following block and the corresponding line in the constructor.
    // You also need to subscribe to the objects with `this.subscribeObjects`, similar to `this.subscribeStates`.
    // /**
    //  * Is called if a subscribed object changes
    //  * @param {string} id
    //  * @param {ioBroker.Object | null | undefined} obj
    //  */
    // onObjectChange(id, obj) {
    //     if (obj) {
    //         // The object was changed
    //         this.log.info(`object ${id} changed: ${JSON.stringify(obj)}`);
    //     } else {
    //         // The object was deleted
    //         this.log.info(`object ${id} deleted`);
    //     }
    // }

    /**
     * Is called if a subscribed state changes
     * @param {string} id
     * @param {ioBroker.State | null | undefined} state
     */
    onStateChange(id, state) {
        if (state) {
            // The state was changed
            this.log.info(`state ${id} changed: ${state.val} (ack = ${state.ack})`);
        } else {
            // The state was deleted
            this.log.info(`state ${id} deleted`);
        }
    }

    // If you need to accept messages in your adapter, uncomment the following block and the corresponding line in the constructor.
    // /**
    //  * Some message was sent to this instance over message box. Used by email, pushover, text2speech, ...
    //  * Using this method requires "common.messagebox" property to be set to true in io-package.json
    //  * @param {ioBroker.Message} obj
    //  */
    // onMessage(obj) {
    //     if (typeof obj === 'object' && obj.message) {
    //         if (obj.command === 'send') {
    //             // e.g. send email or pushover or whatever
    //             this.log.info('send command');

    //             // Send response in callback if required
    //             if (obj.callback) this.sendTo(obj.from, obj.command, 'Message received', obj.callback);
    //         }
    //     }
    // }

}

if (require.main !== module) {
    // Export the constructor in compact mode
    /**
     * @param {Partial<utils.AdapterOptions>} [options={}]
     */
    module.exports = (options) => new TailscaleVpn(options);
} else {
    // otherwise start the instance directly
    new TailscaleVpn();
}