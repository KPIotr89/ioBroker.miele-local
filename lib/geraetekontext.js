'use strict';

/*
 * Den Geraetekontext (DOP2 2/1585, GLOBAL_DeviceContext) auswerten - ohne Adapter pruefbar.
 *
 * WAS DORT STEHT. Feld 6 ist die Struktur DeviceAttributesDWTDWM, die Miele fuer Waschmaschine,
 * Trockner und Spuelmaschine fuehrt. Darin unter anderem:
 *
 *   6.1   doorState                         Tuer (1 offen, 2 zu, 3 verriegelt)
 *   6.3   Energie des letzten Programms     Generic-Huelle, Einheit laut Feld 6 der Huelle
 *   6.4   Wasser des letzten Programms      dto.
 *   6.5   Energie gesamt (Lebenszaehler)    an G7197/G7655: 121 = Wh   (ha-miele-at-lan)
 *   6.6   Wasser gesamt (Lebenszaehler)     an G7197/G7655:  44 = l    (ha-miele-at-lan)
 *   6.7   Dosierbehaelter (TwinDos/AutoDos) Liste von Strukturen, DOP2-Typ 33
 *   6.29  aktuelle Leistungsaufnahme        Einheit ungeprueft
 *   6.31  aktuelle Wassermenge              Einheit ungeprueft
 *
 * WARUM DER EINHEITENTYP ZAEHLT. Die Huelle sagt selbst, was sie zaehlt. Ein Modell, das in
 * Kilowattstunden (45) statt Wattstunden (121) meldet, wuerde sonst um den Faktor tausend falsch
 * gelesen. Ohne Typangabe und mit Wert 0 fuehrt das Geraet den Zaehler nicht - dann gibt es auch
 * keinen Wert (null), keine 0.
 *
 * AN DEN EIGENEN GERAETEN (Stand 13.11.2026) beantwortet keines 2/1585 (XKM EK037/EK057: 404
 * bzw. 500). Die Auswertung ist deshalb an oeffentlichen Abzuegen geprueft, nicht an eigenen.
 */

const dop2 = require('./dop2');

/** Einheitentypen der Generic-Huelle, die eine Energie bzw. ein Volumen bedeuten. */
const ENERGIE_WH = 121;
const ENERGIE_KWH = 45;
const WASSER_L = 44;

/**
 * Wert und Einheitentyp einer Wertehuelle.
 *
 * @param {object|undefined} feld {type, value} bzw. {id, type, value}
 * @returns {{wert: unknown, typ: number|null}|null} null, wenn das Feld fehlt
 */
function huelle(feld) {
    if (!feld) {
        return null;
    }
    if (feld.type !== dop2.TYP_STRUKTUR || !Array.isArray(feld.value)) {
        return { wert: dop2.reinerWert(feld.value), typ: null };
    }
    const wert = dop2.reinerWert(dop2.wertAusStruktur(feld.value));
    const t = feld.value.length >= 5 ? feld.value.find(e => e && e.id === 6) : null;
    const typ = t ? Number(dop2.reinerWert(t.value)) || null : null;
    return { wert, typ };
}

/**
 * Eine Energie in Wh - nur bei bekanntem Einheitentyp.
 *
 * @param {{wert: unknown, typ: number|null}|null} h Ergebnis von huelle()
 * @returns {number|null} Wattstunden
 */
function energieWh(h) {
    if (!h || typeof h.wert !== 'number') {
        return null;
    }
    if (h.typ === ENERGIE_WH) {
        return h.wert;
    }
    if (h.typ === ENERGIE_KWH) {
        return h.wert * 1000;
    }
    return null;
}

/**
 * Ein Volumen in Litern - nur bei bekanntem Einheitentyp.
 *
 * @param {{wert: unknown, typ: number|null}|null} h Ergebnis von huelle()
 * @returns {number|null} Liter
 */
function wasserL(h) {
    if (!h || typeof h.wert !== 'number' || h.typ !== WASSER_L) {
        return null;
    }
    return h.wert;
}

/**
 * Die Felder von 2/1585 auswerten.
 *
 * @param {object} fields wie dop2.parseLeaf sie liefert
 * @returns {{
 *   hatAttribute: boolean,
 *   tuer: number|null,
 *   energieLetzteWh: number|null, wasserLetzteL: number|null,
 *   energieGesamtWh: number|null, wasserGesamtL: number|null,
 *   roh: object,
 *   dosierbehaelter: Array<object>|null
 * }} Auswertung; Werte null, wo das Geraet nichts fuehrt
 */
function auswerten(fields) {
    const leer = {
        hatAttribute: false,
        tuer: null,
        energieLetzteWh: null,
        wasserLetzteL: null,
        energieGesamtWh: null,
        wasserGesamtL: null,
        roh: {},
        dosierbehaelter: null,
    };
    const f6 = fields && fields[6];
    if (!f6 || f6.type !== dop2.TYP_STRUKTUR || !Array.isArray(f6.value)) {
        return leer;
    }
    const innen = {};
    for (const e of f6.value) {
        if (e && typeof e === 'object' && typeof e.id === 'number') {
            innen[e.id] = e;
        }
    }
    const aus = Object.assign({}, leer, { hatAttribute: true });
    const tuer = huelle(innen[1]);
    aus.tuer = tuer && typeof tuer.wert === 'number' ? tuer.wert : null;
    const h = {};
    for (const nr of [3, 4, 5, 6, 29, 31]) {
        h[nr] = huelle(innen[nr]);
        // Fuer das Protokoll: was stand drin, und welche Einheit nennt die Huelle selbst?
        if (h[nr] && (h[nr].typ || h[nr].wert)) {
            aus.roh[`6.${nr}`] = { wert: h[nr].wert, typ: h[nr].typ };
        }
    }
    aus.energieLetzteWh = energieWh(h[3]);
    aus.wasserLetzteL = wasserL(h[4]);
    aus.energieGesamtWh = energieWh(h[5]);
    aus.wasserGesamtL = wasserL(h[6]);

    const f7 = innen[7];
    if (f7 && f7.type === dop2.TYP_STRUKTURLISTE && Array.isArray(f7.value)) {
        aus.dosierbehaelter = f7.value.map(felder => {
            const o = {};
            for (const e of felder || []) {
                const w = huelle(e);
                o[e.id] = w ? w.wert : null;
            }
            return {
                groesseMl: typeof o[3] === 'number' ? o[3] : null,
                dosierungMl: typeof o[5] === 'number' ? o[5] : null,
                fuellstandProzent: typeof o[6] === 'number' ? o[6] : null,
            };
        });
    }
    return aus;
}

/**
 * Eine Zeile fuers Debug-Protokoll - kurz, ohne Kennungen.
 *
 * @param {ReturnType<typeof auswerten>} a Ergebnis von auswerten()
 * @returns {string} lesbare Zusammenfassung
 */
function protokollZeile(a) {
    if (!a.hatAttribute) {
        return 'no device attributes (field 6)';
    }
    const teile = [];
    const zahl = (name, v, einheit) => teile.push(`${name}=${v == null ? '-' : `${v} ${einheit}`}`);
    zahl('lastEnergy', a.energieLetzteWh, 'Wh');
    zahl('lastWater', a.wasserLetzteL, 'l');
    zahl('totalEnergy', a.energieGesamtWh, 'Wh');
    zahl('totalWater', a.wasserGesamtL, 'l');
    if (a.tuer != null) {
        teile.push(`door=${a.tuer}`);
    }
    if (a.dosierbehaelter) {
        teile.push(
            `containers=${a.dosierbehaelter.length}${
                a.dosierbehaelter.length
                    ? ` (${a.dosierbehaelter.map(d => `${d.fuellstandProzent ?? '?'} %`).join(', ')})`
                    : ''
            }`,
        );
    }
    const roh = Object.entries(a.roh)
        .map(([k, v]) => `${k}:${v.wert}${v.typ ? `/t${v.typ}` : ''}`)
        .join(' ');
    if (roh) {
        teile.push(`raw ${roh}`);
    }
    return teile.join(', ');
}

module.exports = { auswerten, huelle, energieWh, wasserL, protokollZeile, ENERGIE_WH, ENERGIE_KWH, WASSER_L };
