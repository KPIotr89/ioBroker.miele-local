'use strict';

/*
 * Eingebauter MQTT-Client: Themen, Nutzlasten, Befehle - mit einem nachgebildeten Client.
 */

const { expect } = require('chai');
const { EventEmitter } = require('node:events');
const m = require('../lib/mqttbruecke');

const LOG = { debug() {}, info() {}, warn() {} };

/** Nachgebildeter MQTT-Client: merkt sich, was veroeffentlicht und abonniert wurde. */
function attrappe() {
    const c = new EventEmitter();
    c.connected = false;
    c.gesendet = [];
    c.abos = [];
    c.publish = (thema, inhalt, opts) => c.gesendet.push([thema, inhalt, !!(opts && opts.retain)]);
    c.subscribe = (thema, cb) => {
        c.abos.push(thema);
        cb && cb(null);
    };
    c.end = () => {
        c.beendet = true;
    };
    return c;
}

describe('MQTT', () => {
    it('welche Datenpunkte hinausgehen: state und eco ganz, aus info nur wenige, kein JSON', () => {
        expect(m.istWert('state', 'status')).to.equal(true);
        expect(m.istWert('state', 'statusText')).to.equal(true);
        expect(m.istWert('eco', 'energy')).to.equal(true);
        expect(m.istWert('eco', 'fieldsJson')).to.equal(false);
        expect(m.istWert('info', 'connected')).to.equal(true);
        expect(m.istWert('info', 'pollTotal')).to.equal(false);
        expect(m.istWert('control', 'start')).to.equal(false);
        expect(m.istWert('history', 'cyclesJson')).to.equal(false);
    });

    it('Nutzlast: Text bleibt Text, Wahrheitswerte 1/0, Ueberlanges und Objekte nicht', () => {
        expect(m.nutzlast('Pracuje')).to.equal('Pracuje');
        expect(m.nutzlast('')).to.equal('');
        expect(m.nutzlast(5)).to.equal('5');
        expect(m.nutzlast(true)).to.equal('1');
        expect(m.nutzlast(false)).to.equal('0');
        expect(m.nutzlast(null)).to.equal(null);
        expect(m.nutzlast({ a: 1 })).to.equal(null);
        expect(m.nutzlast('x'.repeat(201))).to.equal(null);
    });

    it('Praefix: ohne Schraegstriche am Rand, ohne Platzhalter, Vorgabe miele', () => {
        expect(m.praefixBereinigen(' /haus/miele/ ')).to.equal('haus/miele');
        expect(m.praefixBereinigen('mie#le+')).to.equal('miele');
        expect(m.praefixBereinigen('')).to.equal('miele');
        expect(m.praefixBereinigen(undefined)).to.equal('miele');
    });

    it('Befehle: nur bekannte, nur unter dem Praefix, nicht bei 0/false/leer', () => {
        expect(m.befehlLesen('miele', 'miele/000187421679/set/start', Buffer.from('1'))).to.deep.equal({
            deviceId: '000187421679',
            befehl: 'start',
        });
        expect(m.befehlLesen('miele', 'miele/000187421679/set/start', '0')).to.equal(null);
        expect(m.befehlLesen('miele', 'miele/000187421679/set/start', 'false')).to.equal(null);
        expect(m.befehlLesen('miele', 'miele/000187421679/set/start', '')).to.equal(null);
        expect(m.befehlLesen('miele', 'miele/000187421679/set/explode', '1')).to.equal(null);
        expect(m.befehlLesen('miele', 'andere/000187421679/set/start', '1')).to.equal(null);
        expect(m.befehlLesen('miele', 'miele/000187421679/statusText', '1')).to.equal(null);
    });

    it('Bruecke: meldet sich an, veroeffentlicht Aenderungen, nimmt Befehle an', () => {
        const c = attrappe();
        const befehle = [];
        let verbunden = 0;
        let optionen;
        const b = new m.Bruecke({
            host: '192.168.0.50',
            port: 1883,
            user: 'loxberry',
            password: 'geheim',
            praefix: 'miele',
            befehle: true,
            log: LOG,
            beiBefehl: (id, bef) => befehle.push(`${id} ${bef}`),
            beiVerbindung: () => verbunden++,
            verbinde: (url, opts) => {
                expect(url).to.equal('mqtt://192.168.0.50:1883');
                optionen = opts;
                return c;
            },
        });
        b.start();
        expect(optionen.username).to.equal('loxberry');
        expect(optionen.will).to.deep.include({ topic: 'miele/connected', payload: '0', retain: true });

        // vor dem Verbinden geht nichts hinaus
        expect(b.sende('000187421679', 'statusText', 'Pracuje')).to.equal(false);

        c.connected = true;
        c.emit('connect');
        expect(verbunden).to.equal(1);
        expect(c.abos).to.deep.equal(['miele/+/set/+']);
        expect(c.gesendet[0]).to.deep.equal(['miele/connected', '1', true]);

        expect(b.sende('000187421679', 'statusText', 'Pracuje')).to.equal(true);
        expect(b.sende('000187421679', 'statusText', 'Pracuje')).to.equal(false); // unveraendert
        expect(b.sende('000187421679', 'signalDoor', true)).to.equal(true);
        expect(c.gesendet.slice(1)).to.deep.equal([
            ['miele/000187421679/statusText', 'Pracuje', true],
            ['miele/000187421679/signalDoor', '1', true],
        ]);

        // neuer Verbindungsaufbau: alles darf erneut hinaus
        c.emit('connect');
        expect(b.sende('000187421679', 'statusText', 'Pracuje')).to.equal(true);

        c.emit('message', 'miele/000187421679/set/powerOff', Buffer.from('1'));
        c.emit('message', 'miele/000187421679/set/powerOff', Buffer.from('0'));
        expect(befehle).to.deep.equal(['000187421679 powerOff']);

        b.stop();
        expect(c.beendet).to.equal(true);
        expect(c.gesendet[c.gesendet.length - 1]).to.deep.equal(['miele/connected', '0', true]);
    });

    it('ohne Befehle kein Abonnement, retain abschaltbar', () => {
        const c = attrappe();
        const b = new m.Bruecke({ host: 'h', log: LOG, retain: false, verbinde: () => c });
        b.start();
        c.connected = true;
        c.emit('connect');
        expect(c.abos).to.deep.equal([]);
        b.sende('1', 'status', 5);
        expect(c.gesendet[c.gesendet.length - 1]).to.deep.equal(['miele/1/status', '5', false]);
    });
});
