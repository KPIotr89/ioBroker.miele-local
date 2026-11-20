'use strict';

const { expect } = require('chai');
const dop2 = require('../lib/dop2');
const { u8, u16, feld, struktur, liste, annotated, leaf } = require('./lib/dop2bau');

/*
 * DOP2-Typ 33 (AStruct): eine Liste von Strukturen.
 *
 * Bis 0.5.2 brach parseLeaf an diesem Typ mit "Unknown DOP2 field type 33" ab - fuer das GANZE
 * Leaf. Betroffen waren 2/1585 (DeviceContext, Feld 6.7 Dosierbehaelter), 2/17, 2/131 u. a.
 * Die Beispiele hier sind von Hand gebaut, nach dem Aufbau, den ha-miele-at-lan (MIT) und
 * MieleRESTServer beschreiben; geprueft wurde zusaetzlich gegen deren oeffentliche Abzuege
 * (ausserhalb des Repos).
 */
describe('DOP2 Typ 33 (Liste von Strukturen)', () => {
    it('liest eine Liste mit zwei Eintraegen samt Feldnummern', () => {
        const buf = leaf(2, 1585, [
            feld(
                7,
                33,
                liste([
                    [feld(2, 2, u8(13)), feld(3, 5, u16(400)), feld(6, 16, annotated(72))],
                    [feld(2, 2, u8(1)), feld(3, 5, u16(14000)), feld(6, 16, annotated(100))],
                ]),
            ),
        ]);
        const { fields } = dop2.parseLeaf(buf);
        expect(fields[7].type).to.equal(33);
        expect(fields[7].value).to.have.length(2);
        const [a, b] = fields[7].value;
        expect(a.map(e => e.id)).to.deep.equal([2, 3, 6]);
        expect(a[1].value).to.equal(400);
        expect(dop2.wertAusStruktur(a[2].value)).to.equal(72);
        expect(b[1].value).to.equal(14000);
        expect(dop2.reinerWert(fields[7].value)).to.deep.equal([
            [13, 400, [8, 72, 0]],
            [1, 14000, [8, 100, 0]],
        ]);
    });

    it('liest die Felder NACH der Liste an der richtigen Stelle', () => {
        // Der eigentliche Prüfstein: Stimmt die Laenge der Liste nicht, ist jedes folgende Feld
        // verschoben - und genau das verriete sich hier als falscher Wert.
        const buf = leaf(2, 17, [
            feld(1, 2, u8(5)),
            feld(2, 33, liste([[feld(1, 5, u16(0x1234))], [], [feld(1, 5, u16(7)), feld(2, 1, u8(1))]])),
            feld(3, 5, u16(4711)),
        ]);
        const { fields } = dop2.parseLeaf(buf);
        expect(fields[1].value).to.equal(5);
        expect(fields[2].value).to.have.length(3);
        expect(fields[2].value[1], 'leerer Eintrag').to.deep.equal([]);
        expect(fields[2].value[2][1]).to.deep.include({ id: 2, value: true });
        expect(fields[3].value).to.equal(4711);
    });

    it('akzeptiert eine leere Liste', () => {
        const { fields } = dop2.parseLeaf(leaf(2, 131, [feld(1, 33, u16(0)), feld(2, 2, u8(9))]));
        expect(fields[1].value).to.deep.equal([]);
        expect(fields[2].value).to.equal(9);
    });

    it('meldet eine abgeschnittene Liste als Fehler, statt Unsinn zu liefern', () => {
        const ganz = leaf(2, 1, [feld(1, 33, liste([[feld(1, 5, u16(1))]]))]);
        const kaputt = ganz.subarray(0, ganz.length - 3);
        expect(() => dop2.decodeField(33, kaputt, 15)).to.throw(/Truncated/);
    });

    it('verschachtelt Strukturen in Listeneintraegen', () => {
        const innen = struktur([feld(1, 2, u8(1)), feld(2, 2, u8(2))]);
        const { fields } = dop2.parseLeaf(leaf(2, 1585, [feld(9, 33, liste([[feld(4, 16, innen)]]))]));
        expect(dop2.reinerWert(fields[9].value)).to.deep.equal([[[1, 2]]]);
    });
});
