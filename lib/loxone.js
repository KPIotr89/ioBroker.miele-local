'use strict';

/*
 * Direkte Anbindung an einen Loxone Miniserver - ohne MQTT, ohne weiteren Adapter.
 *
 * WARUM UDP. Der Miniserver spricht kein MQTT; wer MQTT nutzt, braucht dazwischen ein Gateway,
 * das am Ende doch wieder UDP oder HTTP an den Miniserver schickt. Virtuelle UDP-Eingaenge
 * kennt jeder Miniserver, sie brauchen kein Benutzerkonto und nehmen Werte ohne Abfragetakt an.
 *
 * WAS GESENDET WIRD. Je Wert ein Datagramm, reiner Text:
 *     miele/<Seriennummer>/<Wert>=<Zahl>
 * z. B. "miele/000187421679/status=5". Wahrheitswerte gehen als 1/0. Texte (statusText …) kann
 * ein UDP-Eingang nicht aufnehmen - in Loxone uebersetzt ein Status-Baustein die Zahl in Text.
 * Gesendet wird bei jeder Aenderung und zusaetzlich alles in festem Abstand: UDP kennt keine
 * Quittung, und nach einem Neustart des Miniservers waeren die Eingaenge sonst leer.
 *
 * BEFEHLE. In der Gegenrichtung schickt ein virtueller Ausgang des Miniservers
 *     miele/<Seriennummer>/<Befehl>
 * per UDP an den Adapter (Adresse /dev/udp/<ioBroker-IP>/<Port>). Angenommen wird nur, was vom
 * eingetragenen Miniserver kommt, und nur mit eingeschalteter Geraetesteuerung.
 *
 * VORLAGEN. Loxone Config liest Vorlagen fuer virtuelle Ein- und Ausgaenge als XML ein
 * (VIU_….xml / VO_….xml). Der Aufbau unten entspricht Dateien, die Loxone Config selbst
 * schreibt: UTF-8 mit BOM, Zeilenende CRLF.
 */

const dgram = require('node:dgram');
const namen = require('./names');

const PRAEFIX = 'miele';

/** Die Werte, die an den Miniserver gehen: Kanal, Datenpunkt, englischer Name, Einheit. */
const WERTE = [
    ['info', 'connected', 'Connected', ''],
    ['state', 'status', 'Status', ''],
    ['state', 'programId', 'Program', ''],
    ['state', 'programType', 'Program type', ''],
    ['state', 'programPhase', 'Phase', ''],
    ['state', 'remainingMinutes', 'Remaining time', 'min'],
    ['state', 'elapsedMinutes', 'Elapsed time', 'min'],
    ['state', 'startInMinutes', 'Start in', 'min'],
    ['state', 'progress', 'Progress', '%'],
    ['state', 'targetTemperature', 'Target temperature', '°C'],
    ['state', 'temperature', 'Temperature', '°C'],
    ['state', 'spinningSpeed', 'Spin speed', 'rpm'],
    ['state', 'dryingStep', 'Drying step', ''],
    ['state', 'signalDoor', 'Door', ''],
    ['state', 'signalInfo', 'Info', ''],
    ['state', 'signalFailure', 'Failure', ''],
    ['state', 'mobileStart', 'Remote control enabled', ''],
    ['state', 'light', 'Light', ''],
    ['eco', 'energy', 'Energy', 'kWh'],
    ['eco', 'water', 'Water', 'l'],
];

/** Befehle, die der Miniserver schicken darf - dieselben wie unter control.*. */
const BEFEHLE = [
    ['start', 'Start'],
    ['stop', 'Stop'],
    ['pause', 'Pause'],
    ['powerOn', 'Power on'],
    ['powerOff', 'Power off'],
    ['lightOn', 'Light on'],
    ['lightOff', 'Light off'],
];

const WERT_SCHLUESSEL = new Set(WERTE.map(w => `${w[0]}.${w[1]}`));

/**
 * Gehoert der Datenpunkt zu den Werten fuer Loxone?
 *
 * @param {string} kanal info | state | eco
 * @param {string} sub Name des Datenpunkts
 * @returns {boolean} ja oder nein
 */
function istWert(kanal, sub) {
    return WERT_SCHLUESSEL.has(`${kanal}.${sub}`);
}

/**
 * Einen Wert als Zahl fuer den UDP-Eingang.
 *
 * @param {unknown} val Wert des Datenpunkts
 * @returns {number|null} Zahl; null, wenn sich der Wert nicht als Zahl senden laesst
 */
function zahl(val) {
    if (typeof val === 'boolean') {
        return val ? 1 : 0;
    }
    if (typeof val === 'number' && Number.isFinite(val)) {
        return val;
    }
    return null;
}

/**
 * Der Text eines Datagramms.
 *
 * @param {string} deviceId Seriennummer
 * @param {string} sub Name des Datenpunkts
 * @param {unknown} val Wert
 * @returns {string|null} "miele/<id>/<sub>=<Zahl>" oder null ohne sendbaren Wert
 */
function nachricht(deviceId, sub, val) {
    const z = zahl(val);
    return z == null ? null : `${PRAEFIX}/${deviceId}/${sub}=${z}`;
}

/**
 * Einen empfangenen Befehl lesen.
 *
 * @param {string} text Inhalt des Datagramms
 * @returns {{deviceId: string, befehl: string}|null} Geraet und Befehl; null, wenn es keiner ist
 */
function befehlLesen(text) {
    const m = /^miele\/([A-Za-z0-9_-]{1,40})\/([A-Za-z]{1,20})$/.exec(String(text || '').trim());
    if (!m || !BEFEHLE.some(b => b[0] === m[2])) {
        return null;
    }
    return { deviceId: m[1], befehl: m[2] };
}

/**
 * Kurze Erklaerung je Wert fuer das Kommentarfeld des Eingangs (en, de, pl; sonst Englisch).
 * Bei status, programType, programPhase und dryingStep haengt kommentar() die Wertetabelle an.
 */
const ERKLAERUNG = {
    connected: {
        en: 'Appliance reachable in the network: 1 = yes, 0 = no.',
        de: 'Gerät im Netzwerk erreichbar: 1 = ja, 0 = nein.',
        pl: 'Urządzenie osiągalne w sieci: 1 = tak, 0 = nie.',
    },
    status: { en: 'Operating state.', de: 'Betriebszustand.', pl: 'Stan pracy urządzenia.' },
    programId: {
        en: 'Number of the selected programme; the name is in programText (MQTT).',
        de: 'Nummer des gewählten Programms; der Name steht in programText (MQTT).',
        pl: 'Numer wybranego programu; nazwa jest w programText (MQTT).',
    },
    programType: { en: 'Kind of programme.', de: 'Art des Programms.', pl: 'Rodzaj programu.' },
    programPhase: {
        en: 'Phase within the running programme.',
        de: 'Abschnitt des laufenden Programms.',
        pl: 'Etap trwającego programu.',
    },
    remainingMinutes: {
        en: 'Remaining time of the programme in minutes; 0 while nothing runs.',
        de: 'Restzeit des Programms in Minuten; 0, solange nichts läuft.',
        pl: 'Czas do końca programu w minutach; 0, gdy nic nie pracuje.',
    },
    elapsedMinutes: {
        en: 'Time since the programme started, in minutes.',
        de: 'Zeit seit Programmstart in Minuten.',
        pl: 'Czas od startu programu w minutach.',
    },
    startInMinutes: {
        en: 'Delayed start: minutes until the programme begins; 0 without delay.',
        de: 'Startvorwahl: Minuten bis zum Programmstart; 0 ohne Vorwahl.',
        pl: 'Opóźniony start: minuty do rozpoczęcia programu; 0 bez opóźnienia.',
    },
    progress: {
        en: 'Programme progress in percent; 0 while nothing runs.',
        de: 'Programmfortschritt in Prozent; 0, solange nichts läuft.',
        pl: 'Postęp programu w procentach; 0, gdy nic nie pracuje.',
    },
    targetTemperature: {
        en: 'Selected temperature in °C.',
        de: 'Gewählte Temperatur in °C.',
        pl: 'Wybrana temperatura w °C.',
    },
    temperature: {
        en: 'Current temperature in °C, where the appliance reports it.',
        de: 'Aktuelle Temperatur in °C, sofern das Gerät sie meldet.',
        pl: 'Aktualna temperatura w °C, jeśli urządzenie ją podaje.',
    },
    spinningSpeed: {
        en: 'Selected spin speed in rpm.',
        de: 'Gewählte Schleuderdrehzahl in U/min.',
        pl: 'Wybrane obroty wirowania w obr./min.',
    },
    dryingStep: { en: 'Selected drying level.', de: 'Gewählte Trockenstufe.', pl: 'Wybrany stopień suszenia.' },
    signalDoor: {
        en: 'Door: 1 = open, 0 = closed.',
        de: 'Tür: 1 = offen, 0 = zu.',
        pl: 'Drzwi: 1 = otwarte, 0 = zamknięte.',
    },
    signalInfo: {
        en: 'Notice on the appliance display: 1 = yes.',
        de: 'Hinweis im Gerätedisplay: 1 = ja.',
        pl: 'Komunikat na wyświetlaczu urządzenia: 1 = tak.',
    },
    signalFailure: { en: 'Fault: 1 = yes.', de: 'Störung: 1 = ja.', pl: 'Usterka: 1 = tak.' },
    mobileStart: {
        en: 'Remote start enabled on the appliance: 1 = yes. Start commands only work then.',
        de: 'Fernstart am Gerät freigegeben: 1 = ja. Nur dann wirkt der Startbefehl.',
        pl: 'Zdalny start włączony na urządzeniu: 1 = tak. Tylko wtedy działa polecenie start.',
    },
    light: { en: 'Light: 1 = on.', de: 'Licht: 1 = an.', pl: 'Oświetlenie: 1 = włączone.' },
    energy: {
        en: 'Energy of the programme in kWh - the appliance estimate, not a measurement.',
        de: 'Energie des Programms in kWh - Erwartung des Geräts, keine Messung.',
        pl: 'Energia programu w kWh - szacunek urządzenia, nie pomiar.',
    },
    water: {
        en: 'Water consumption of the programme in litres.',
        de: 'Wasserverbrauch des Programms in Litern.',
        pl: 'Zużycie wody w programie w litrach.',
    },
};
/** Werte mit Wertetabelle: Datenpunkt -> Art in lib/werte.js. */
const TABELLEN = { status: 'status', programType: 'programType', programPhase: 'phase', dryingStep: 'dryingStep' };
const KOMMENTAR_MAX = 900;

/**
 * Kommentar eines Eingangs: Erklaerung und, wo es eine gibt, die Wertetabelle "Zahl = Text".
 *
 * @param {string} sub Name des Datenpunkts
 * @param {string} [sp] Sprache
 * @param {number|null} [deviceType] Miele-Geraeteart (fuer die Phasen)
 * @returns {string} Kommentar
 */
function kommentar(sub, sp, deviceType) {
    const e = ERKLAERUNG[sub];
    let text = e ? e[sp] || e.en : '';
    const art = TABELLEN[sub];
    if (art) {
        // erst hier laden: lib/werte.js bindet lib/objects.js ein, das Namen aus lib/names.js holt
        const t = require('./werte').werteTabelle(art, sp || 'en', deviceType == null ? null : deviceType);
        if (t && t.options.length) {
            let liste = '';
            for (const o of t.options) {
                const stueck = `${liste ? ', ' : ''}${o.value} = ${o.label}`;
                if (text.length + liste.length + stueck.length > KOMMENTAR_MAX) {
                    liste += ' …';
                    break;
                }
                liste += stueck;
            }
            text = `${text} ${liste}`.trim();
        }
    }
    return text;
}

/**
 * Text fuer ein XML-Attribut.
 *
 * @param {unknown} s Rohtext
 * @returns {string} maskierter Text
 */
function attr(s) {
    return String(s == null ? '' : s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

/**
 * Name eines Werts in der gewuenschten Sprache.
 *
 * @param {string} kanal info | state | eco
 * @param {string} sub Name des Datenpunkts
 * @param {string} en englischer Name
 * @param {string} [sp] Sprache
 * @param {(kanal: string, sub: string, en: string) => string|null} [nameFn] eigene Namensquelle, geht vor
 * @returns {string} Name ohne den Zusatz in Klammern
 */
function wertName(kanal, sub, en, sp, nameFn) {
    // eco hat in lib/names.js keine uebersetzten Kurznamen
    const eigen = { energy: { de: 'Energie', pl: 'Energia' }, water: { de: 'Wasser', pl: 'Woda' } };
    if (kanal === 'eco' && eigen[sub] && eigen[sub][sp]) {
        return eigen[sub][sp];
    }
    const t = sp && sp !== 'en' && namen.SPRACHNAMEN[kanal] && namen.SPRACHNAMEN[kanal][sub];
    const name = (nameFn && nameFn(kanal, sub, en)) || (t && t[sp]) || en;
    // "Status (wartość surowa)" -> "Status": In Loxone gibt es den Text daneben nicht
    return name.replace(/\s*[(（][^)）]*[)）]\s*$/, '');
}

/**
 * Datei im Format von Loxone Config: BOM, CRLF.
 *
 * @param {string[]} zeilen Zeilen der Datei
 * @returns {string} Dateiinhalt
 */
function datei(zeilen) {
    // BOM als Zeichencode: ein woertliches BOM in der Quelle ist unsichtbar
    return `${String.fromCharCode(0xfeff)}${zeilen.join('\r\n')}\r\n`;
}

/**
 * Vorlage fuer die virtuellen UDP-Eingaenge (VIU_….xml).
 *
 * @param {object} o Angaben
 * @param {number} o.port UDP-Port, auf dem der Miniserver empfaengt
 * @param {{id: string, name: string, deviceType?: number|null, vorhanden?: Set<string>}[]} o.geraete Geraete; `vorhanden`
 *   nennt die angelegten Datenpunkte ("state.status") - ohne Angabe kommen alle Werte hinein
 * @param {string} [o.sprache] Sprache der Namen
 * @param {(kanal: string, sub: string, en: string) => string|null} [o.nameFn] eigene Namensquelle
 * @param {'direkt'|'loxberry'} [o.format] Datagramme des Adapters oder des LoxBerry MQTT Gateways
 * @param {string} [o.praefix] MQTT-Themenpraefix (nur LoxBerry)
 * @returns {string} XML
 */
function vorlageEingaenge({ port, geraete, sprache, nameFn, format, praefix }) {
    // LoxBerry MQTT Gateway: "MQTT: <Thema>=<Wert>" an den UDP-Port des Miniservers (Vorgabe 11883)
    const loxberry = format === 'loxberry';
    const pfad = loxberry ? `MQTT: ${praefix || PRAEFIX}` : PRAEFIX;
    const vorgabePort = loxberry ? 11883 : 7000;
    const titel = loxberry ? 'Miele (LoxBerry MQTT)' : 'Miele';
    const z = [
        '<?xml version="1.0" encoding="utf-8"?>',
        `<VirtualInUdp Title="${titel}" Comment="ioBroker.miele-local" Address="" Port="${Number(port) || vorgabePort}">`,
        '\t<Info templateType="1" minVersion="12000000"/>',
    ];
    for (const g of geraete) {
        for (const [kanal, sub, en, einheit] of WERTE) {
            if (g.vorhanden && !g.vorhanden.has(`${kanal}.${sub}`)) {
                continue;
            }
            const name = `${g.name} - ${wertName(kanal, sub, en, sprache, nameFn)}`;
            const unit = einheit ? `<v> ${einheit}` : '<v>';
            const beschreibung = kommentar(sub, sprache, g.deviceType);
            z.push(
                `\t<VirtualInUdpCmd Title="${attr(name)}" Comment="${attr(beschreibung)}" Address="" ` +
                    `Check="${attr(`${pfad}/${g.id}/${sub}=\\v`)}" Signed="true" Analog="true" ` +
                    `SourceValLow="0" DestValLow="0" SourceValHigh="100" DestValHigh="100" DefVal="0" ` +
                    `MinVal="-1000000" MaxVal="1000000" Unit="${attr(unit)}" HintText=""/>`,
            );
        }
    }
    z.push('</VirtualInUdp>');
    return datei(z);
}

/**
 * Vorlage fuer die virtuellen Ausgaenge mit den Befehlen (VO_….xml).
 *
 * @param {object} o Angaben
 * @param {string} o.host IP-Adresse von ioBroker
 * @param {number} o.port UDP-Port, auf dem der Adapter Befehle annimmt
 * @param {{id: string, name: string}[]} o.geraete Geraete
 * @returns {string} XML
 */
function vorlageAusgaenge({ host, port, geraete }) {
    const z = [
        '<?xml version="1.0" encoding="utf-8"?>',
        `<VirtualOut Title="Miele" Comment="ioBroker.miele-local" Address="${attr(`/dev/udp/${host}/${Number(port)}`)}" ` +
            `CmdInit="" HintText="" CloseAfterSend="true" CmdSep=";">`,
        '\t<Info templateType="3" minVersion="12000000"/>',
    ];
    for (const g of geraete) {
        for (const [befehl, en] of BEFEHLE) {
            z.push(
                `\t<VirtualOutCmd Title="${attr(`${g.name} ${en}`)}" Comment="" CmdOnMethod="GET" CmdOffMethod="GET" ` +
                    `CmdOn="${attr(`${PRAEFIX}/${g.id}/${befehl}`)}" CmdOnHTTP="" CmdOnPost="" CmdOff="" CmdOffHTTP="" ` +
                    `CmdOffPost="" CmdAnswer="" HintText="" Analog="false" Repeat="0" RepeatRate="0"/>`,
            );
        }
    }
    z.push('</VirtualOut>');
    return datei(z);
}

/**
 * Die eigene IP-Adresse in Richtung eines Ziels (fuer die Adresse des virtuellen Ausgangs).
 *
 * @param {string} ziel IP-Adresse des Miniservers
 * @returns {Promise<string|null>} eigene Adresse oder null
 */
function eigeneIp(ziel) {
    return new Promise(resolve => {
        const s = dgram.createSocket('udp4');
        const ende = ip => {
            try {
                s.close();
            } catch {
                /* schon zu */
            }
            resolve(ip);
        };
        s.on('error', () => ende(null));
        try {
            // UDP "verbinden" sendet nichts, legt aber die Absenderadresse fest
            s.connect(9, ziel, () => ende(s.address().address));
        } catch {
            ende(null);
        }
    });
}

/** Sendet Werte per UDP an den Miniserver - nur Aenderungen, auf Wunsch alles. */
class Sender {
    /**
     * @param {object} o Angaben
     * @param {string} o.host IP-Adresse des Miniservers
     * @param {number} o.port UDP-Port des virtuellen Eingangs
     * @param {{debug: (m: string) => void, warn: (m: string) => void}} o.log Protokoll
     */
    constructor({ host, port, log }) {
        this.host = host;
        this.port = Number(port) || 7000;
        this.log = log;
        this.letzte = new Map();
        this.gesendet = 0;
        this.socket = dgram.createSocket('udp4');
        this.socket.on('error', e => this.log.warn(`Loxone UDP: ${e.message}`));
        this.socket.unref();
    }

    /**
     * Einen Wert senden.
     *
     * @param {string} deviceId Seriennummer
     * @param {string} sub Name des Datenpunkts
     * @param {unknown} val Wert
     * @param {boolean} [immer] auch senden, wenn sich nichts geaendert hat
     * @returns {boolean} ob gesendet wurde
     */
    sende(deviceId, sub, val, immer) {
        const text = nachricht(deviceId, sub, val);
        if (!text || !this.socket) {
            return false;
        }
        const schluessel = `${deviceId}/${sub}`;
        if (!immer && this.letzte.get(schluessel) === text) {
            return false;
        }
        this.letzte.set(schluessel, text);
        const daten = Buffer.from(text, 'utf8');
        this.socket.send(daten, this.port, this.host, e => {
            if (e) {
                this.log.debug(`Loxone UDP ${text}: ${e.message}`);
            }
        });
        this.gesendet++;
        return true;
    }

    /** Socket schliessen. */
    stop() {
        if (this.socket) {
            try {
                this.socket.close();
            } catch {
                /* schon zu */
            }
            this.socket = null;
        }
    }
}

/** Nimmt Befehle des Miniservers per UDP an. */
class Empfaenger {
    /**
     * @param {object} o Angaben
     * @param {number} o.port UDP-Port
     * @param {string} o.erlaubt IP-Adresse des Miniservers - nur von dort wird angenommen
     * @param {(deviceId: string, befehl: string) => void} o.beiBefehl Rueckruf je Befehl
     * @param {{debug: (m: string) => void, info: (m: string) => void, warn: (m: string) => void}} o.log Protokoll
     */
    constructor({ port, erlaubt, beiBefehl, log }) {
        this.port = Number(port);
        this.erlaubt = erlaubt;
        this.beiBefehl = beiBefehl;
        this.log = log;
        this.socket = null;
    }

    /**
     * Ein Datagramm pruefen und, wenn es ein Befehl des Miniservers ist, weitergeben.
     *
     * @param {Buffer|string} daten Inhalt
     * @param {string} von Absenderadresse
     * @returns {boolean} ob ein Befehl weitergegeben wurde
     */
    annehmen(daten, von) {
        if (von !== this.erlaubt) {
            this.log.debug(`Loxone command from ${von} ignored (only ${this.erlaubt} is accepted)`);
            return false;
        }
        const b = befehlLesen(daten.toString('utf8').slice(0, 200));
        if (!b) {
            this.log.debug(`Loxone command not understood: ${daten.toString('utf8').slice(0, 80)}`);
            return false;
        }
        this.beiBefehl(b.deviceId, b.befehl);
        return true;
    }

    /** Port oeffnen. */
    start() {
        this.socket = dgram.createSocket('udp4');
        this.socket.on('error', e => this.log.warn(`Loxone command port ${this.port}: ${e.message}`));
        this.socket.on('message', (daten, rinfo) => this.annehmen(daten, rinfo.address));
        this.socket.bind(this.port, () => this.log.info(`Loxone commands accepted on UDP port ${this.port}.`));
    }

    /** Port schliessen. */
    stop() {
        if (this.socket) {
            try {
                this.socket.close();
            } catch {
                /* schon zu */
            }
            this.socket = null;
        }
    }
}

module.exports = {
    PRAEFIX,
    WERTE,
    BEFEHLE,
    istWert,
    zahl,
    nachricht,
    befehlLesen,
    wertName,
    kommentar,
    vorlageEingaenge,
    vorlageAusgaenge,
    eigeneIp,
    Sender,
    Empfaenger,
};
