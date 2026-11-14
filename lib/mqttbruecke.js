'use strict';

/*
 * Eingebauter MQTT-Client: veroeffentlicht die Werte der Geraete auf einem vorhandenen Broker.
 *
 * WOZU NEBEN UDP. Ein virtueller UDP-Eingang des Loxone Miniservers nimmt nur Zahlen an. Ueber
 * MQTT gehen auch die Texte (statusText, programText …) hinaus - das LoxBerry MQTT Gateway
 * reicht sie als virtuelle Texteingaenge an den Miniserver weiter, und die Zuordnung Zahl ->
 * Text muss in Loxone nicht nachgebaut werden. Ausserdem nutzt jeder andere MQTT-Abnehmer
 * (Node-RED, Home Assistant …) dieselben Themen.
 *
 * THEMEN. Je Wert ein Thema, als Text, auf Wunsch "retained":
 *     <Praefix>/<Seriennummer>/<Wert>        z. B. miele/000187421679/statusText = Pracuje
 * Wahrheitswerte gehen als 1/0. <Praefix>/connected zeigt mit 1/0, ob der Adapter laeuft
 * (Last Will). Befehle kommen ueber
 *     <Praefix>/<Seriennummer>/set/<Befehl>
 * mit beliebigem Inhalt ausser "0", "false" und leer.
 */

const loxone = require('./loxone');

/** Kanaele, deren Datenpunkte vollstaendig hinausgehen. */
const KANAELE = new Set(['state', 'eco']);
/** Einzelne Datenpunkte aus info. */
const INFO = new Set(['connected', 'techType', 'deviceType']);
/** Laengere Texte (JSON-Sammlungen) gehoeren nicht in ein Thema je Wert. */
const MAX_TEXT = 200;

/**
 * Geht der Datenpunkt per MQTT hinaus?
 *
 * @param {string} kanal info | state | eco
 * @param {string} sub Name des Datenpunkts
 * @returns {boolean} ja oder nein
 */
function istWert(kanal, sub) {
    if (/Json$/.test(sub)) {
        return false;
    }
    return KANAELE.has(kanal) || (kanal === 'info' && INFO.has(sub));
}

/**
 * Der Praefix ohne Schraegstriche an den Enden und ohne Platzhalter.
 *
 * @param {unknown} praefix Eingabe
 * @returns {string} bereinigter Praefix, ohne Angabe "miele"
 */
function praefixBereinigen(praefix) {
    const p = String(praefix == null ? '' : praefix)
        .trim()
        .replace(/[#+]/g, '')
        .replace(/^\/+|\/+$/g, '');
    return p || 'miele';
}

/**
 * Wert als MQTT-Nutzlast.
 *
 * @param {unknown} val Wert des Datenpunkts
 * @returns {string|null} Text; null, wenn der Wert nicht hinausgeht
 */
function nutzlast(val) {
    if (typeof val === 'boolean') {
        return val ? '1' : '0';
    }
    if (typeof val === 'number') {
        return Number.isFinite(val) ? String(val) : null;
    }
    if (typeof val === 'string') {
        return val.length <= MAX_TEXT ? val : null;
    }
    return null;
}

/**
 * Ein empfangenes Thema als Befehl lesen.
 *
 * @param {string} praefix bereinigter Praefix
 * @param {string} thema empfangenes Thema
 * @param {Buffer|string} inhalt Nutzlast
 * @returns {{deviceId: string, befehl: string}|null} Geraet und Befehl; null, wenn es keiner ist
 */
function befehlLesen(praefix, thema, inhalt) {
    const anfang = `${praefix}/`;
    if (!String(thema).startsWith(anfang)) {
        return null;
    }
    const m = /^([A-Za-z0-9_-]{1,40})\/set\/([A-Za-z]{1,20})$/.exec(String(thema).slice(anfang.length));
    if (!m || !loxone.BEFEHLE.some(b => b[0] === m[2])) {
        return null;
    }
    const text = String(inhalt == null ? '' : inhalt)
        .trim()
        .toLowerCase();
    if (text === '' || text === '0' || text === 'false' || text === 'off') {
        return null;
    }
    return { deviceId: m[1], befehl: m[2] };
}

/** Haelt die Verbindung zum Broker und veroeffentlicht Werte. */
class Bruecke {
    /**
     * @param {object} o Angaben
     * @param {string} o.host Adresse des Brokers
     * @param {number} [o.port] Port des Brokers (Vorgabe 1883)
     * @param {string} [o.user] Benutzername
     * @param {string} [o.password] Kennwort
     * @param {string} [o.praefix] Themenpraefix (Vorgabe "miele")
     * @param {boolean} [o.retain] Werte "retained" veroeffentlichen (Vorgabe ja)
     * @param {boolean} [o.befehle] Befehle annehmen
     * @param {string} [o.clientId] Client-Kennung
     * @param {(deviceId: string, befehl: string) => void} [o.beiBefehl] Rueckruf je Befehl
     * @param {() => void} [o.beiVerbindung] Rueckruf nach jedem Verbindungsaufbau
     * @param {{debug: (m: string) => void, info: (m: string) => void, warn: (m: string) => void}} o.log Protokoll
     * @param {(url: string, opts: object) => object} [o.verbinde] Verbindungsaufbau (fuer Tests)
     */
    constructor(o) {
        this.o = o;
        this.log = o.log;
        this.praefix = praefixBereinigen(o.praefix);
        this.retain = o.retain !== false;
        this.letzte = new Map();
        this.client = null;
        this.fehlerGemeldet = false;
    }

    /** Verbindung aufbauen; der Client verbindet sich nach einem Abbruch selbst neu. */
    start() {
        const verbinde = this.o.verbinde || require('mqtt').connect;
        const url = `mqtt://${this.o.host}:${Number(this.o.port) || 1883}`;
        const status = `${this.praefix}/connected`;
        this.client = verbinde(url, {
            clientId: this.o.clientId || `iobroker-miele-local-${Math.random().toString(16).slice(2, 8)}`,
            username: this.o.user || undefined,
            password: this.o.password || undefined,
            reconnectPeriod: 10000,
            connectTimeout: 10000,
            will: { topic: status, payload: '0', retain: true, qos: 0 },
        });
        this.client.on('connect', () => {
            this.fehlerGemeldet = false;
            this.log.info(`MQTT: connected to ${url}, topics under ${this.praefix}/`);
            this.client.publish(status, '1', { retain: true, qos: 0 });
            if (this.o.befehle) {
                this.client.subscribe(`${this.praefix}/+/set/+`, e => {
                    if (e) {
                        this.log.warn(`MQTT: could not subscribe to commands - ${e.message}`);
                    }
                });
            }
            // Nach jedem Verbindungsaufbau alles neu: Der Broker kann neu gestartet sein
            this.letzte.clear();
            if (this.o.beiVerbindung) {
                this.o.beiVerbindung();
            }
        });
        this.client.on('error', e => {
            // einmal melden, nicht bei jedem Verbindungsversuch
            if (!this.fehlerGemeldet) {
                this.fehlerGemeldet = true;
                this.log.warn(`MQTT: ${e.message}`);
            } else {
                this.log.debug(`MQTT: ${e.message}`);
            }
        });
        this.client.on('message', (thema, inhalt) => {
            const b = befehlLesen(this.praefix, thema, inhalt);
            if (b && this.o.beiBefehl) {
                this.o.beiBefehl(b.deviceId, b.befehl);
            }
        });
    }

    /**
     * Einen Wert veroeffentlichen.
     *
     * @param {string} deviceId Seriennummer
     * @param {string} sub Name des Datenpunkts
     * @param {unknown} val Wert
     * @returns {boolean} ob veroeffentlicht wurde
     */
    sende(deviceId, sub, val) {
        const text = nutzlast(val);
        if (text == null || !this.client || !this.client.connected) {
            return false;
        }
        const thema = `${this.praefix}/${deviceId}/${sub}`;
        if (this.letzte.get(thema) === text) {
            return false;
        }
        this.letzte.set(thema, text);
        this.client.publish(thema, text, { retain: this.retain, qos: 0 });
        return true;
    }

    /** Verbindung beenden; vorher "nicht verbunden" hinterlassen. */
    stop() {
        if (this.client) {
            try {
                if (this.client.connected) {
                    this.client.publish(`${this.praefix}/connected`, '0', { retain: true, qos: 0 });
                }
                this.client.end();
            } catch {
                /* schon zu */
            }
            this.client = null;
        }
    }
}

module.exports = { istWert, praefixBereinigen, nutzlast, befehlLesen, Bruecke };
