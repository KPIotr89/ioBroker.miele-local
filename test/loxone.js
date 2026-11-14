'use strict';

/*
 * Anbindung an Loxone: Datagramme, Befehle und die Vorlagen fuer Loxone Config.
 */

const { expect } = require('chai');
const dgram = require('node:dgram');
const loxone = require('../lib/loxone');

const LOG = { debug() {}, info() {}, warn() {} };
const GERAETE = [
    { id: '000187421679', name: 'Pralka WWF664', vorhanden: new Set(['state.status', 'state.remainingMinutes']) },
    { id: '000178578094', name: 'Suszarka "TWF" <760>' },
];

describe('Loxone', () => {
    it('Datagramm: Zahl und Wahrheitswert, kein Text', () => {
        expect(loxone.nachricht('000187421679', 'status', 5)).to.equal('miele/000187421679/status=5');
        expect(loxone.nachricht('000187421679', 'signalDoor', true)).to.equal('miele/000187421679/signalDoor=1');
        expect(loxone.nachricht('000187421679', 'signalDoor', false)).to.equal('miele/000187421679/signalDoor=0');
        expect(loxone.nachricht('000187421679', 'energy', 0.75)).to.equal('miele/000187421679/energy=0.75');
        expect(loxone.nachricht('000187421679', 'statusText', 'Pracuje')).to.equal(null);
        expect(loxone.nachricht('000187421679', 'status', null)).to.equal(null);
        expect(loxone.nachricht('000187421679', 'status', NaN)).to.equal(null);
    });

    it('nur die vorgesehenen Werte gehen hinaus', () => {
        expect(loxone.istWert('state', 'status')).to.equal(true);
        expect(loxone.istWert('info', 'connected')).to.equal(true);
        expect(loxone.istWert('state', 'statusText')).to.equal(false);
        expect(loxone.istWert('control', 'start')).to.equal(false);
    });

    it('Befehle: nur bekannte, nur in der festen Form', () => {
        expect(loxone.befehlLesen('miele/000187421679/start')).to.deep.equal({
            deviceId: '000187421679',
            befehl: 'start',
        });
        expect(loxone.befehlLesen(' miele/000187421679/powerOff\r\n').befehl).to.equal('powerOff');
        expect(loxone.befehlLesen('miele/000187421679/explode')).to.equal(null);
        expect(loxone.befehlLesen('miele/../control/start')).to.equal(null);
        expect(loxone.befehlLesen('miele/000187421679/start/x')).to.equal(null);
        expect(loxone.befehlLesen('')).to.equal(null);
    });

    it('Empfaenger nimmt nur vom Miniserver an', () => {
        const gesehen = [];
        const e = new loxone.Empfaenger({
            port: 0,
            erlaubt: '192.168.0.10',
            log: LOG,
            beiBefehl: (id, b) => gesehen.push(`${id} ${b}`),
        });
        expect(e.annehmen(Buffer.from('miele/000187421679/start'), '192.168.0.99')).to.equal(false);
        expect(e.annehmen(Buffer.from('unsinn'), '192.168.0.10')).to.equal(false);
        expect(e.annehmen(Buffer.from('miele/000187421679/start'), '192.168.0.10')).to.equal(true);
        expect(gesehen).to.deep.equal(['000187421679 start']);
    });

    it('Vorlage der Eingaenge: Aufbau wie von Loxone Config, nur vorhandene Werte', () => {
        const xml = loxone.vorlageEingaenge({ port: 7001, geraete: GERAETE, sprache: 'pl' });
        expect(xml.charCodeAt(0)).to.equal(0xfeff);
        expect(xml).to.include('\r\n');
        expect(xml).to.include('<VirtualInUdp Title="Miele" Comment="ioBroker.miele-local" Address="" Port="7001">');
        expect(xml).to.include('Check="miele/000187421679/status=\\v"');
        expect(xml).to.include('Title="Pralka WWF664 - Status"');
        expect(xml).to.include('Unit="&lt;v&gt; min"');
        // erstes Geraet: nur die zwei vorhandenen Werte, zweites: alle
        expect((xml.match(/miele\/000187421679\//g) || []).length).to.equal(2);
        expect((xml.match(/miele\/000178578094\//g) || []).length).to.equal(loxone.WERTE.length);
        // Sonderzeichen im Namen duerfen das XML nicht zerlegen
        expect(xml).to.include('Suszarka &quot;TWF&quot; &lt;760&gt;');
        expect(xml.trim().endsWith('</VirtualInUdp>')).to.equal(true);
    });

    it('Kommentar: Erklaerung in der Sprache, mit Wertetabelle wo es eine gibt', () => {
        expect(loxone.kommentar('status', 'pl', 1)).to.match(/^Stan pracy urządzenia\. .*5 = Pracuje/);
        expect(loxone.kommentar('status', 'de', 1)).to.include('5 = In Betrieb');
        expect(loxone.kommentar('programPhase', 'pl', 2)).to.include('514 = Suszenie');
        expect(loxone.kommentar('dryingStep', 'pl', 2)).to.include('0 = Ekstra suche');
        expect(loxone.kommentar('remainingMinutes', 'pl', 1)).to.equal(
            'Czas do końca programu w minutach; 0, gdy nic nie pracuje.',
        );
        expect(loxone.kommentar('status', 'fr', 1)).to.match(/^Operating state\. /);
        for (const [, sub] of loxone.WERTE) {
            const k = loxone.kommentar(sub, 'pl', 1);
            expect(k, sub).to.be.a('string').and.not.equal('');
            expect(k.length, sub).to.be.below(1000);
        }
    });

    it('Vorlage fuer das LoxBerry MQTT Gateway: "MQTT: <Thema>=", Port 11883, Praefix', () => {
        const xml = loxone.vorlageEingaenge({
            geraete: GERAETE,
            sprache: 'pl',
            format: 'loxberry',
            praefix: 'haus/miele',
        });
        expect(xml).to.include('Title="Miele (LoxBerry MQTT)"');
        expect(xml).to.include('Port="11883"');
        expect(xml).to.include('Check="MQTT: haus/miele/000187421679/status=\\v"');
        expect(xml).to.include('Comment="Stan pracy urządzenia. ');
        const ohne = loxone.vorlageEingaenge({ geraete: GERAETE, format: 'loxberry' });
        expect(ohne).to.include('Check="MQTT: miele/000187421679/status=\\v"');
    });

    it('Namen der Eingaenge: Sprache, ohne Klammerzusatz, eigene Quelle geht vor', () => {
        expect(loxone.wertName('state', 'status', 'Status', 'pl')).to.equal('Status');
        expect(loxone.wertName('state', 'remainingMinutes', 'Remaining time', 'pl')).to.equal('Pozostały czas');
        expect(loxone.wertName('eco', 'energy', 'Energy', 'pl')).to.equal('Energia');
        expect(loxone.wertName('eco', 'energy', 'Energy', 'fr')).to.equal('Energy');
        expect(loxone.wertName('state', 'status', 'Status', 'pl', () => 'Stan (x)')).to.equal('Stan');
    });

    it('Vorlage der Ausgaenge: UDP-Adresse des Adapters, ein Ausgang je Befehl', () => {
        const xml = loxone.vorlageAusgaenge({ host: '192.168.0.201', port: 18083, geraete: GERAETE });
        expect(xml).to.include('Address="/dev/udp/192.168.0.201/18083"');
        expect(xml).to.include('CmdOn="miele/000187421679/start"');
        expect((xml.match(/<VirtualOutCmd /g) || []).length).to.equal(GERAETE.length * loxone.BEFEHLE.length);
        expect(xml.trim().endsWith('</VirtualOut>')).to.equal(true);
    });

    it('Sender: schickt Aenderungen, wiederholt nur auf Wunsch', done => {
        const empfang = dgram.createSocket('udp4');
        const bekommen = [];
        empfang.on('message', m => {
            bekommen.push(m.toString('utf8'));
            if (bekommen.length === 3) {
                expect(bekommen).to.deep.equal(['miele/0001/status=5', 'miele/0001/status=7', 'miele/0001/status=7']);
                sender.stop();
                empfang.close(done);
            }
        });
        let sender;
        empfang.bind(0, '127.0.0.1', () => {
            sender = new loxone.Sender({ host: '127.0.0.1', port: empfang.address().port, log: LOG });
            expect(sender.sende('0001', 'status', 5)).to.equal(true);
            expect(sender.sende('0001', 'status', 5)).to.equal(false); // unveraendert
            expect(sender.sende('0001', 'statusText', 'x')).to.equal(false); // kein Zahlenwert
            expect(sender.sende('0001', 'status', 7)).to.equal(true);
            expect(sender.sende('0001', 'status', 7, true)).to.equal(true); // erzwungen
        });
    });
});
