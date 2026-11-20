'use strict';

/*
 * Aus einem gelesenen Leaf-Feld einen ioBroker-Datenpunkt machen - oder eben keinen.
 *
 * WOZU
 * Die Namenstabelle (lib/leafnamen.js) sagt, WIE ein Feld heisst. Sie sagt nicht, ob das eigene
 * Geraet es fuehrt: Sie stammt von fremden Geraeten, und ein Backofen kennt die Felder einer
 * Waschmaschine nicht. Wer alle Namen blind anlegt, bekommt hunderte Datenpunkte, die auf 0
 * stehen und in der Anzeige nicht von einer echten Null zu unterscheiden sind.
 *
 * DESHALB DIE REGEL: Ein Datenpunkt entsteht erst, wenn das Geraet das Feld tatsaechlich
 * geliefert hat - mit dem Typ, den der gelieferte Wert hat. Liefert es das Feld nicht, gibt es
 * den Punkt nicht. Das kostet einen Programmlauf Geduld und erspart einen Baum voller Nullen.
 *
 * EINHEITEN NUR, WO SIE GEMESSEN SIND
 * Ein Name wie "currentPowerConsumption" sagt, WAS gezaehlt wird, nicht in welchen Schritten.
 * Hier steht ein Teiler nur dort, wo er an einem echten Geraet gegen eine unabhaengige Quelle
 * geprueft wurde (siehe lib/felder.js, EINHEITEN). Fuer alles andere steht der Rohwert da -
 * lieber eine nackte Zahl als eine falsch skalierte.
 */

const leafnamen = require('./leafnamen');
const dop2 = require('./dop2');
const namen = require('./names');

/**
 * Unter welchem Kanal die Felder einer Struktur stehen.
 *
 * Der Kanal ist bewusst nicht die Leaf-Nummer: "detail.process.heatingEnergy" ist zu lesen,
 * "detail.2_6195.25" nicht. Strukturen ohne Eintrag landen unter ihrer Adresse - sie sind
 * selten, und eine erfundene Uebersetzung waere schlechter als die Nummer.
 */
const KANAELE = {
    Process: 'process',
    ActuatorData: 'actuators',
    Sensor: 'sensors',
    CSHoursOfOperation: 'operatingTime',
    DeviceState: 'deviceState',
    DeviceCombiState: 'combinedState',
    DeviceContext: 'context',
    DeviceAttributesDWTDWM: 'ecoFeedback',
    DeviceAttributesCCA: 'ecoFeedback',
    ProgramList: 'programList',
    XkmStateInfo: 'module',
    XkmIdent: 'module',
    SoftwareBuild: 'software',
    Failure: 'failure',
    FailureList: 'failure',
    FeatureList: 'features',
    PSAttributesCCA: 'programState',
    PSContext: 'programState',
    CSContext: 'programState',
    // Ersatzteil-Kennzeichnung, die die Spuelmaschine unter 2/173 und 2/174 fuehrt
    // ("1 EPWX ID" und ein Barcode). Kein Messwert, aber im Servicefall die Auskunft,
    // welches Bauteil verbaut ist - deshalb ein eigener Kanal statt der nackten Adresse.
    PartName: 'service',
    CSBarcode: 'service',
};

/**
 * Strukturen, aus denen KEIN Datenpunkt entsteht.
 *
 * DeviceIdentStrings (2/145) traegt Seriennummer, Modell und Materialnummer - und alle drei
 * stehen laengst im Baum: `info.fabNumber` (Rolle info.serial), `info.techType`,
 * `info.matNumber`, gefuellt aus der Geraetekennung. Ein zweiter Satz derselben Angaben unter
 * `detail` waere kein Gewinn, sondern eine zweite Wahrheit, die beim naechsten Umbau von der
 * ersten abweicht.
 *
 * Der Datenschutz spielt hier NICHT hinein: Der Objektbaum bleibt in der eigenen Instanz. Die
 * Seriennummer wegzulassen ist eine Regel der DATENSAMMLUNG, weil die weitergegeben wird -
 * siehe lib/sammler.js.
 *
 * Die Dateisystem- und Uebertragungsstrukturen sind Protokollinnenleben und fuer niemanden ein
 * Messwert.
 */
const NICHT_ANLEGEN = new Set([
    'DeviceIdentStrings',
    'FileList',
    'FileInfo',
    'FileWrite',
    'FileTransfer',
    'RsaKey',
    'HeisluftPlus',
    'NotificationAcknowledge',
    'UserRequest',
    'XkmRequest',
]);

/**
 * Was ueber einzelne Felder mehr bekannt ist als ihr Name.
 *
 * Schluessel ist "Struktur.Feldnummer". `teiler` und `einheit` stehen nur dort, wo beides
 * nachgemessen ist; die Belege stehen in lib/felder.js. `rolle` steuert nur die Anzeige.
 */
const BESONDERS = {
    // Belegt an der WCR860 (siehe lib/felder.js, EINHEITEN).
    'Process.15': { teiler: 10, einheit: '°C', rolle: 'value.temperature' },
    // Rolle 'value' statt 'value.volume': Letztere kennt der ioBroker-Rollenkatalog nicht,
    // der Pruefer meldet sie als E1008. Gleiche Entscheidung wie in main.js und objects.js.
    'Process.21': { teiler: 200, einheit: 'l', rolle: 'value' },
    'Process.65': { teiler: 2, einheit: 'kg', rolle: 'value' },
    /*
     * F25/F26: die VORGABE fuer die Heizung der Hauptwaesche, keine Messung.
     *
     * Belegt ueber 31 Laeufe der WCR860 (13.11.2026): F26/F25 = 3600 s/h / 2020 W, also
     * F25 = geplante Heizzeit x Nennleistung des Heizstabs bei 230 V. Einmal zu Beginn der
     * Heizung gesetzt, nie nachgefuehrt; kalte und kurze Programme melden 0.
     */
    'Process.25': { einheit: 'Wh', rolle: 'value.power.consumption' },
    'Process.26': { einheit: 's', rolle: 'value.interval' },
    /*
     * F16: Antriebsenergie in Wh - zaehlt waehrend des Laufs aufwaerts, OHNE Heizstab.
     *
     * Belegt an 13 Programmen der WCR860 (13.11.2026, R^2 0,999 gegen die Steckdose ohne den
     * Heizanteil): beim Schleudern +4-7 je Minute, beim Heizen nur +1,3 wie in unbeheizten
     * Phasen. Deckt vor allem den Antrieb; bei Spuel- und Kurzprogrammen fehlt bis 85 % des
     * Nicht-Heiz-Anteils. Faellt beim Uebergang in den Ruhezustand auf 0 - siehe
     * geraeteWerteSchreiben (Endstand halten).
     */
    'Process.16': { einheit: 'Wh', rolle: 'value.power.consumption' },
    // Ohne Teiler: am 15.09.2026 stand dort 40 bei einem 40-Grad-Programm, also ganze Grad.
    'Process.24': { einheit: '°C', rolle: 'value.temperature' },
    'Process.4': { einheit: 'min', rolle: 'value.interval' },
    'Process.27': { einheit: 'rpm', rolle: 'value' },
    'Sensor.3': { einheit: 'rpm', rolle: 'value' },
    // 2/119 zaehlt in Minuten - am laufenden Geraet nachgemessen, siehe lib/felder.js.
    'CSHoursOfOperation.1': { teiler: 60, einheit: 'h', rolle: 'value.interval' },
    'CSHoursOfOperation.2': { teiler: 60, einheit: 'h', rolle: 'value.interval' },
    'CSHoursOfOperation.3': { teiler: 60, einheit: 'h', rolle: 'value.interval' },
    'CSHoursOfOperation.4': { teiler: 60, einheit: 'h', rolle: 'value.interval' },
    'CSHoursOfOperation.5': { teiler: 60, einheit: 'h', rolle: 'value.interval' },
    'DeviceState.7': { einheit: 's', rolle: 'value.interval' },
    'DeviceState.8': { einheit: 's', rolle: 'value.interval' },
};

/**
 * Deutsche Beschriftungen fuer die Felder, die jemand wirklich ansieht.
 *
 * Ohne Eintrag bleibt der englische Name aus der Reverse-Engineering-Arbeit stehen. Das ist
 * Absicht: Ein erfundener deutscher Name fuer ein Feld, dessen Bedeutung niemand geprueft hat,
 * taeuscht Wissen vor, das nicht da ist.
 */
const DEUTSCH = {
    // Zaehlt AUFWAERTS (13.11.2026 an der WCR860 belegt) - bis 0.5.2 stand hier "Restzeit".
    'Process.4': 'Laufzeit',
    'Process.5': 'Programmphase',
    'Process.8': 'Heizrelais',
    'Process.15': 'Temperatur am Frequenzumrichter',
    'Process.21': 'Wasser (Durchflusszähler)',
    'Process.24': 'Zieltemperatur der Heizung',
    'Process.16': 'Antriebsenergie',
    'Process.25': 'Heizenergie (Vorgabe)',
    'Process.26': 'Heizzeit (Vorgabe)',
    'Process.27': 'Trommeldrehzahl',
    'Process.65': 'Beladung',
    'ActuatorData.1': 'Heizung 1',
    'ActuatorData.7': 'Heizung 2',
    'ActuatorData.2': 'Laugenpumpe',
    'ActuatorData.3': 'Intensivpumpe',
    'Sensor.1': 'Wasserstand',
    'Sensor.3': 'Schleuderdrehzahl',
    'Sensor.4': 'Türschalter',
    'Sensor.5': 'Türverriegelung',
    'CSHoursOfOperation.1': 'Betriebszeit gesamt',
    'CSHoursOfOperation.2': 'Betriebszeit vor dem Austausch',
    'CSHoursOfOperation.3': 'Betriebszeit seit der letzten Wartung',
    'DeviceState.7': 'Restzeit',
    'DeviceState.8': 'Laufzeit',
    'DeviceCombiState.1': 'Gerätezustand',
    'DeviceCombiState.2': 'Betriebszustand',
    'DeviceCombiState.3': 'Prozesszustand',
};

/**
 * Englische Beschriftungen, wo der Feldname aus der Reverse-Engineering-Arbeit irrefuehrt.
 *
 * Sonst steht der Feldname selbst da ("heatingEnergy"). Bei diesen vier Feldern sagt er etwas
 * Falsches oder zu wenig: F4 heisst "remainingTimeInMinutes", zaehlt aber aufwaerts; F25/F26
 * klingen nach Messung und sind eine Vorgabe; F16 "energyConsumed" ist nur der Antrieb. Die
 * Objekt-IDs bleiben der Feldname - nur die Anzeige aendert sich (Bestandsschutz).
 */
const ENGLISCH = {
    'Process.4': 'Elapsed time',
    'Process.16': 'Drive energy',
    'Process.25': 'Heating energy (setpoint)',
    'Process.26': 'Heating time (setpoint)',
};

/**
 * Aus den geparsten Feldern eines Leafs die ISTWERTE holen - auch aus Unterstrukturen.
 *
 * DREI FAELLE, und sie sehen im Abzug gleich aus:
 *
 *   1. Ein Messwert in seiner Huelle:  Feld 25 = [Maske, 2020, Deutung]   -> 2020
 *   2. Eine Liste:                     Feld 2  = [1, 133, 3, ...]         -> die Liste
 *   3. Eine weitere Struktur:          2/1585 Feld 6 = die EcoFeedback-Werte des Geraets
 *
 * Fall 3 laesst sich nicht an den Daten erkennen, nur an der Namenstabelle: Sie sagt, hinter
 * welchem Feld eine benannte Unterstruktur steckt (lib/leafnamen.js, UNTERSTRUKTUR). Genau da
 * liegen die Zahlen, die Miele in der App anzeigt - deshalb ist der Fall die Muehe wert.
 *
 * @param {string} leaf   "2/1585"
 * @param {object} fields wie parseLeaf sie liefert: {idx: {type, value}}
 * @returns {Array} [{struktur, idx, wert, pfad}] - pfad ist "6.4" bei Unterstrukturen
 */
function istwerte(leaf, fields) {
    const struktur = leafnamen.strukturVon(leaf);
    if (!struktur) {
        return [];
    }
    return ausStruktur(struktur, fields, '');
}

function ausStruktur(struktur, fields, praefix) {
    const aus = [];
    const unter = leafnamen.UNTERSTRUKTUR[struktur] || {};
    for (const [idx, f] of Object.entries(fields || {})) {
        if (!f) {
            continue;
        }
        const nr = Number(idx);
        const kind = unter[nr];
        if (kind && f.type === dop2.TYP_STRUKTUR && Array.isArray(f.value)) {
            /*
             * Eine benannte Unterstruktur - ihre Felder tragen eigene Nummern.
             *
             * Die Nummern sind lueckenhaft: 2/1585 Feld 6 (die EcoFeedback-Werte) zaehlt
             * 1, 3, 4, 5 ... 36. Deshalb wird jedes Feld ueber SEINE Nummer zugeordnet und
             * nicht ueber seine Stelle. Ein Abzug ohne Nummern - so entstanden alle vor dem
             * 15.09.2026 - wird uebersprungen statt falsch gedeutet.
             */
            const innen = {};
            for (const e of f.value) {
                if (e && typeof e === 'object' && typeof e.id === 'number') {
                    innen[e.id] = e;
                }
            }
            if (Object.keys(innen).length) {
                for (const u of ausStruktur(kind, innen, `${praefix}${nr}.`)) {
                    aus.push(u);
                }
                continue;
            }
        }
        if (f.type === dop2.TYP_STRUKTURLISTE && Array.isArray(f.value)) {
            // Eine Liste von Strukturen (Typ 33) - ein JSON-Wert, je Eintrag ein Objekt mit Namen.
            aus.push({ struktur, idx: nr, wert: listeLesbar(kind, f.value), pfad: `${praefix}${nr}` });
            continue;
        }
        const wert =
            f.type === dop2.TYP_STRUKTUR && Array.isArray(f.value)
                ? dop2.reinerWert(dop2.wertAusStruktur(f.value))
                : dop2.reinerWert(f.value);
        if (wert === undefined || wert === null) {
            continue;
        }
        const eintrag = { struktur, idx: nr, wert, pfad: `${praefix}${nr}` };
        const typ = f.type === dop2.TYP_STRUKTUR ? einheitTypVon(f.value) : null;
        if (typ != null) {
            eintrag.einheitTyp = typ;
        }
        aus.push(eintrag);
    }
    return aus;
}

/**
 * Der Einheitentyp einer Generic-Wertehuelle (Feld 6, "IntType"), oder null.
 *
 * Die Generic-Huelle traegt neben dem Istwert (Feld 4) in Feld 6 eine Kennung, WAS gezaehlt wird.
 * ha-miele-at-lan nennt fuer die Spuelmaschinen-Zaehler unter 2/1585 Feld 6.5/6.6 die Werte
 * 121 (GLOBAL_VALINT_ENERGY_WH) und 44 (GLOBAL_VALINT_ECO_WATER_LITER), an G7197/G7655 gegen
 * die Miele-App geprueft; 45 heisst dort Kilowattstunden. Eine Huelle ohne diese Angabe (0) sagt
 * nichts ueber die Einheit - dann bleibt es beim Rohwert.
 *
 * @param {Array} struktur Sub-Felder einer Wertehuelle
 * @returns {number|null} Kennung des Einheitentyps, null ohne Angabe
 */
function einheitTypVon(struktur) {
    if (!Array.isArray(struktur) || struktur.length < 5) {
        return null;
    }
    const e = struktur.find(x => x && typeof x === 'object' && x.id === 6);
    const v = e ? dop2.reinerWert(e.value) : null;
    return typeof v === 'number' && v > 0 ? v : null;
}

/** Bekannte Einheitentypen der Generic-Huelle - siehe einheitTypVon. */
const EINHEIT_TYP = {
    121: { einheit: 'Wh', rolle: 'value.power.consumption' },
    // "EcoEnergyWatt" (dop2rs); an der WCR860 als Wh gelesen - Beleg in lib/geraetekontext.js.
    46: { einheit: 'Wh', rolle: 'value.power.consumption' },
    45: { einheit: 'kWh', rolle: 'value.power.consumption' },
    44: { einheit: 'l', rolle: 'value' },
};

/**
 * Eine Liste von Strukturen (DOP2-Typ 33) lesbar machen: je Eintrag ein Objekt.
 *
 * Schluessel ist der Feldname, wo die Namenstabelle ihn kennt, sonst die Feldnummer. Steckt in
 * einem Feld eine Wertehuelle, steht dort ihr Istwert - wie bei jedem anderen Feld auch.
 *
 * @param {string|undefined} struktur Name der Struktur eines Eintrags, falls bekannt
 * @param {Array} elemente wie dop2 sie liefert: je Eintrag eine Liste {id, type, value}
 * @returns {Array<object>} je Eintrag ein Objekt
 */
function listeLesbar(struktur, elemente) {
    return elemente.map(felder => {
        const o = {};
        for (const e of Array.isArray(felder) ? felder : []) {
            if (!e || typeof e !== 'object') {
                continue;
            }
            const name = (struktur && leafnamen.feldNameIn(struktur, e.id)) || String(e.id);
            o[name] =
                e.type === dop2.TYP_STRUKTUR && Array.isArray(e.value)
                    ? dop2.reinerWert(dop2.wertAusStruktur(e.value))
                    : dop2.reinerWert(e.value);
        }
        return o;
    });
}

/**
 * Die EcoFeedback-Zaehler des Geraets (2/1585 Feld 6.3-6.6) und die Momentanwerte 6.29/6.31.
 *
 * Sie werden NUR angelegt, wenn das Geraet sie wirklich fuehrt: Wert ungleich 0 oder ein
 * Einheitentyp gesetzt. Ein Geraet ohne EcoFeedback liefert hier leere Huellen [0,0,0,0,0,0]
 * (so an der Trocknerseite der WTW870 und an allen Spuelmaschinen fuer 6.3/6.4 gesehen) - als
 * Datenpunkt stuende dort eine 0, die wie "nichts verbraucht" aussieht.
 */
const NUR_MIT_INHALT = new Set([3, 4, 5, 6, 29, 31].map(n => `DeviceAttributesDWTDWM.${n}`));

/**
 * Der Kanal einer Struktur.
 *
 * EINE UNTERSTRUKTUR GEHOERT ZU IHREM LEAF, nicht in einen eigenen Zweig. Am 19.09.2026 an
 * der Spuelmaschine gesehen: Feld 2 von 2/256 ist die Struktur "RemoteEnable" mit den vier
 * Freigaben fuer Fernbedienung. Sie steht in keiner Kanaltabelle, und so landeten ihre Felder
 * unter "leaf2_256", waehrend die uebrigen elf Felder desselben Leaf unter "deviceState"
 * standen - derselbe Abruf, zwei Kanaele, und der eine mit einer Nummer als Namen.
 *
 * Deshalb faellt der Kanal der Reihe nach zurueck: eigener Eintrag, sonst der des Leaf, und
 * erst wenn auch der fehlt, die Adresse.
 *
 * @param {string} struktur  Name der Struktur, in der das Feld steht
 * @param {string} leaf      "2/256"
 */
function kanalFuer(struktur, leaf) {
    if (KANAELE[struktur]) {
        return KANAELE[struktur];
    }
    const traeger = leafnamen.strukturVon(leaf);
    if (traeger && KANAELE[traeger]) {
        return KANAELE[traeger];
    }
    return `leaf${String(leaf || struktur).replace(/[^0-9A-Za-z]+/g, '_')}`;
}

/**
 * Was ein gelieferter Wert fuer ein ioBroker-Objekt bedeutet.
 *
 * Der Typ kommt aus dem WERT, nicht aus der Namenstabelle: Ein Feld, das die Tabelle als Zahl
 * fuehrt, kann auf einem anderen Geraet ein Wahrheitswert sein. Listen werden als JSON
 * abgelegt - ein Datenpunkt je Listenelement waere bei einer Programmliste mit zwanzig
 * Eintraegen ein Baum ohne Nutzen.
 *
 * @param wert vom Geraet gelieferter Wert
 */
function typVon(wert) {
    if (typeof wert === 'boolean') {
        return { type: 'boolean', role: 'indicator', def: false };
    }
    if (typeof wert === 'number') {
        return { type: 'number', role: 'value', def: 0 };
    }
    if (typeof wert === 'string') {
        return { type: 'string', role: 'text', def: '' };
    }
    if (Array.isArray(wert)) {
        return { type: 'string', role: 'json', def: '' };
    }
    return null;
}

/**
 * Die Definition eines Datenpunkts fuer ein geliefertes Feld - oder null.
 *
 * @param {string} leaf       "2/6195"
 * @param {string} struktur    Name der Struktur, in der das Feld steht
 * @param {number|string} idx  Feldnummer INNERHALB dieser Struktur
 * @param {unknown} wert       der Wert, den das Geraet geliefert hat
 * @param {boolean} deutsch    deutsche Beschriftungen
 * @param {number|null} [einheitTyp] Einheitentyp der Wertehuelle (siehe einheitTypVon)
 * @returns {{kanal: string, sub: string, common: object, wert: unknown}|null} Kanal, Name, common-Teil und Wert des Datenpunkts; null, wenn keiner angelegt wird
 */
function definition(leaf, struktur, idx, wert, deutsch, einheitTyp = null) {
    if (!struktur || NICHT_ANLEGEN.has(struktur)) {
        return null;
    }
    if (NUR_MIT_INHALT.has(`${struktur}.${Number(idx)}`) && !einheitTyp && (wert === 0 || wert === false)) {
        return null;
    }
    const name = leafnamen.feldNameIn(struktur, idx);
    // Ohne Namen kein Datenpunkt: Eine Zahl namens "42" hilft niemandem, und der Rohwert steht
    // ohnehin im Verlauf und in der CSV.
    if (!name) {
        return null;
    }
    const typ = typVon(wert);
    if (!typ) {
        return null;
    }

    const schluessel = `${struktur}.${Number(idx)}`;
    // Gemessen (BESONDERS) geht vor dem, was die Huelle ueber sich selbst sagt.
    const extra = BESONDERS[schluessel] || (einheitTyp && EINHEIT_TYP[einheitTyp]) || {};
    let val = wert;
    if (typ.type === 'string' && typ.role === 'json') {
        val = JSON.stringify(wert);
    }
    if (typ.type === 'number' && extra.teiler) {
        val = Math.round((Number(wert) / extra.teiler) * 100) / 100;
    }

    const englisch = ENGLISCH[schluessel] || name;
    const beschriftung = DEUTSCH[schluessel] ? namen.text(DEUTSCH[schluessel], englisch, deutsch) : englisch;
    const common = {
        name: beschriftung,
        role: (typ.type === 'number' && extra.rolle) || typ.role,
        type: typ.type,
        read: true,
        write: false,
        def: typ.def,
    };
    if (extra.einheit && typ.type === 'number') {
        common.unit = extra.einheit;
    }
    return { kanal: kanalFuer(struktur, leaf), sub: name, common, wert: val };
}

/**
 * Alle Datenpunkte, die ein gelesenes Leaf hergibt.
 *
 * @param {string} leaf    "2/6195"
 * @param {object} fields  wie parseLeaf sie liefert: {idx: {type, value}}
 * @param {boolean} deutsch deutsche Beschriftungen
 * @returns {Array} Definitionen, moeglicherweise leer
 */
function fuerLeaf(leaf, fields, deutsch) {
    const aus = [];
    for (const w of istwerte(leaf, fields)) {
        const d = definition(leaf, w.struktur, w.idx, w.wert, deutsch, w.einheitTyp || null);
        if (d) {
            aus.push(d);
        }
    }
    return aus;
}

/**
 * Die Kanaele in beiden Sprachen - deutsch als Schluessel, wie ueberall im Adapter.
 *
 * Als eigene Tabelle und nicht im Funktionsrumpf, damit der Uebersetzungstest sie findet:
 * Er sucht die deutschen Namen im Quelltext und prueft, ob lib/names.js alle elf Sprachen
 * dafuer fuehrt. Ein Name, der nur in einer Funktion steht, faellt ihm durch.
 */
const KANAL_NAMEN = {
    process: ['Prozessdaten', 'Process data'],
    actuators: ['Aktoren', 'Actuators'],
    sensors: ['Sensoren', 'Sensors'],
    operatingTime: ['Betriebszeit', 'Operating time'],
    deviceState: ['Gerätezustand', 'Device state'],
    combinedState: ['Zustand (kombiniert)', 'Combined state'],
    context: ['Gerätekontext', 'Device context'],
    ecoFeedback: ['EcoFeedback des Geräts', 'Device EcoFeedback'],
    programList: ['Programmliste', 'Program list'],
    module: ['Kommunikationsmodul', 'Communication module'],
    software: ['Software', 'Software'],
    failure: ['Störungen', 'Failures'],
    features: ['Fähigkeiten', 'Features'],
    programState: ['Programmzustand', 'Program state'],
    service: ['Kundendienst', 'Service'],
};

/**
 * Der Anzeigename eines Kanals.
 *
 * @param kanal Kennung des Kanals
 * @param deutsch deutsche Beschriftungen
 */
function kanalName(kanal, deutsch) {
    const t = KANAL_NAMEN[kanal];
    return t ? namen.text(t[0], t[1], deutsch) : kanal;
}

module.exports = {
    EINHEIT_TYP,
    ENGLISCH,
    einheitTypVon,
    listeLesbar,
    KANAELE,
    KANAL_NAMEN,
    NICHT_ANLEGEN,
    BESONDERS,
    DEUTSCH,
    definition,
    fuerLeaf,
    istwerte,
    kanalFuer,
    kanalName,
    typVon,
};
