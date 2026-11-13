'use strict';

/*
 * DOP2-Leafs fuer Tests von Hand bauen - eigene Minimalbeispiele, keine fremden Abzuege.
 *
 * Aufbau wie am Geraet (siehe docs/DOP2-Protokoll.md): 12 Byte Kopf
 * [u16 Laenge][u16 Unit][u16 Attribut][u16 idx1][u16 idx2][u8 0][u8 Feldzahl], danach die Felder
 * als [u16 Feldnummer][u8 Typ][Wert].
 */

const u8 = v => Buffer.from([v & 0xff]);
const u16 = v => {
    const b = Buffer.alloc(2);
    b.writeUInt16BE(v);
    return b;
};
const u32 = v => {
    const b = Buffer.alloc(4);
    b.writeUInt32BE(v);
    return b;
};

/** Ein Feld: [u16 Nummer][u8 Typ][Wert]. */
const feld = (id, typ, wert) => Buffer.concat([u16(id), u8(typ), wert]);

/** Struktur (Typ 16): [u16 Feldzahl][Felder]. */
const struktur = felder => Buffer.concat([u16(felder.length), ...felder]);

/** Liste von Strukturen (Typ 33): [u16 Anzahl] und je Element [u16 Feldzahl][Felder]. */
const liste = elemente => Buffer.concat([u16(elemente.length), ...elemente.map(f => struktur(f))]);

/** Generic-Wertehuelle [Maske, min, max, Istwert, Schritt, Einheitentyp] als Struktur. */
const generic = (wert, einheitTyp = 0, maske = 8) =>
    struktur([
        feld(1, 2, u8(maske)),
        feld(2, 8, u32(0)),
        feld(3, 8, u32(0)),
        feld(4, 8, u32(wert)),
        feld(5, 8, u32(0)),
        feld(6, 7, u16(einheitTyp)),
    ]);

/** Annotated-Wertehuelle [Maske, Wert, Deutung]. */
const annotated = (wert, maske = 8) => struktur([feld(1, 2, u8(maske)), feld(2, 2, u8(wert)), feld(3, 2, u8(0))]);

/** Ein ganzes Leaf. */
function leaf(unit, attr, felder) {
    const rumpf = Buffer.concat(felder);
    const kopf = Buffer.concat([u16(0), u16(unit), u16(attr), u16(0), u16(0), u8(0), u8(felder.length)]);
    const buf = Buffer.concat([kopf, rumpf]);
    buf.writeUInt16BE(buf.length - 2, 0);
    return buf;
}

module.exports = { u8, u16, u32, feld, struktur, liste, generic, annotated, leaf };
