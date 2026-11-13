'use strict';

const { expect } = require('chai');
const dop2 = require('../lib/dop2');
const gk = require('../lib/geraetekontext');
const datenpunkte = require('../lib/datenpunkte');
const { u8, u16, feld, struktur, liste, generic, annotated, leaf } = require('./lib/dop2bau');

/*
 * 2/1585 (GLOBAL_DeviceContext) auswerten - mit Einheitentyp.
 *
 * Eigene Minimalbeispiele im Aufbau einer Spuelmaschine: 6.5/6.6 tragen die Lebenszaehler mit
 * Einheitentyp 121 (Wh) bzw. 44 (l), so von ha-miele-at-lan an G7197/G7655 gegen die Miele-App
 * belegt. 6.3/6.4 (letztes Programm) sind leere Huellen - so sahen sie in allen bekannten Abzuegen
 * aus. 6.7 ist eine Liste von Dosierbehaeltern (DOP2-Typ 33).
 */
function kontextLeaf({ letzteWh = null, letzteTyp = 0, gesamtWh = 206600, gesamtTyp = 121, wasserTyp = 44 } = {}) {
    const attribute = struktur([
        feld(1, 4, u8(2)), // doorState: zu
        feld(3, 16, generic(letzteWh || 0, letzteTyp, letzteWh ? 8 : 0)),
        feld(4, 16, generic(0, 0, 0)),
        feld(5, 16, generic(gesamtWh, gesamtTyp)),
        feld(6, 16, generic(2789, wasserTyp)),
        feld(
            7,
            33,
            liste([[feld(2, 2, u8(13)), feld(3, 5, u16(400)), feld(5, 5, u16(65)), feld(6, 16, annotated(3))]]),
        ),
        feld(29, 16, generic(0, 0, 0)),
    ]);
    return dop2.parseLeaf(leaf(2, 1585, [feld(1, 16, struktur([feld(1, 4, u8(5))])), feld(6, 16, attribute)])).fields;
}

describe('Geraetekontext 2/1585', () => {
    it('liest die Lebenszaehler mit Einheitentyp und laesst leere Huellen leer', () => {
        const a = gk.auswerten(kontextLeaf());
        expect(a.hatAttribute).to.equal(true);
        expect(a.energieGesamtWh).to.equal(206600);
        expect(a.wasserGesamtL).to.equal(2789);
        expect(a.energieLetzteWh, 'leere Huelle ist kein Verbrauch von 0').to.equal(null);
        expect(a.wasserLetzteL).to.equal(null);
        expect(a.tuer).to.equal(2);
        expect(a.dosierbehaelter).to.deep.equal([{ groesseMl: 400, dosierungMl: 65, fuellstandProzent: 3 }]);
    });

    it('rechnet Kilowattstunden (Typ 45) in Wh um und verweigert unbekannte Einheiten', () => {
        expect(gk.auswerten(kontextLeaf({ gesamtWh: 207, gesamtTyp: 45 })).energieGesamtWh).to.equal(207000);
        expect(gk.auswerten(kontextLeaf({ gesamtTyp: 99 })).energieGesamtWh).to.equal(null);
        expect(gk.auswerten(kontextLeaf({ wasserTyp: 0 })).wasserGesamtL).to.equal(null);
    });

    it('liefert die Energie des letzten Programms nur mit Einheit', () => {
        expect(gk.auswerten(kontextLeaf({ letzteWh: 950, letzteTyp: 121 })).energieLetzteWh).to.equal(950);
        expect(gk.auswerten(kontextLeaf({ letzteWh: 950, letzteTyp: 0 })).energieLetzteWh).to.equal(null);
    });

    it('nennt im Protokoll Werte, Einheitentypen und Behaelter', () => {
        const z = gk.protokollZeile(gk.auswerten(kontextLeaf()));
        expect(z).to.match(/totalEnergy=206600 Wh/);
        expect(z).to.match(/6\.5:206600\/t121/);
        expect(z).to.match(/containers=1 \(3 %\)/);
        expect(gk.protokollZeile(gk.auswerten({}))).to.match(/no device attributes/);
    });

    it('legt Datenpunkte nur fuer gefuehrte Zaehler an, mit Einheit aus dem Einheitentyp', () => {
        const defs = datenpunkte.fuerLeaf('2/1585', kontextLeaf(), true);
        const nach = Object.fromEntries(defs.map(d => [d.sub, d]));
        expect(nach.ecoFeedbackTotalEnergyConsumption.wert).to.equal(206600);
        expect(nach.ecoFeedbackTotalEnergyConsumption.common.unit).to.equal('Wh');
        expect(nach.ecoFeedbackTotalWaterConsumption.common.unit).to.equal('l');
        expect(nach.ecoFeedbackEnergyConsumptionLastProg, 'leere Huelle').to.equal(undefined);
        expect(nach.ecoFeedbackWaterConsumptionLastProg).to.equal(undefined);
        expect(nach.currentPowerConsumption).to.equal(undefined);
        expect(nach.doorState.wert).to.equal(2);
        // Die Behaelterliste als lesbares JSON mit Feldnamen
        expect(JSON.parse(nach.dosContainerInfo.wert)).to.deep.equal([
            { stateBits: 13, containerSizeMl: 400, currentDosageMl: 65, fillingLevelPercent: 3 },
        ]);
        expect(nach.dosContainerInfo.kanal).to.equal('ecoFeedback');
    });

    it('legt einen Zaehler an, wenn er 0 ist, aber eine Einheit traegt', () => {
        const defs = datenpunkte.fuerLeaf('2/1585', kontextLeaf({ letzteWh: 0, letzteTyp: 121 }), true);
        const d = defs.find(x => x.sub === 'ecoFeedbackEnergyConsumptionLastProg');
        expect(d && d.wert).to.equal(0);
        expect(d.common.unit).to.equal('Wh');
    });
});

describe('Prozessfelder 2/6195: Namen laut Befund 13.11.2026', () => {
    const def = (idx, wert = 1) => datenpunkte.definition('2/6195', 'Process', idx, wert, true);

    it('nennt F25/F26 Vorgabe, F16 Antriebsenergie in Wh und F4 Laufzeit', () => {
        expect(def(25).common.name.de).to.equal('Heizenergie (Vorgabe)');
        expect(def(26).common.name.de).to.equal('Heizzeit (Vorgabe)');
        expect(def(16).common.name.de).to.equal('Antriebsenergie');
        expect(def(16).common.unit).to.equal('Wh');
        expect(def(4).common.name.de).to.equal('Laufzeit');
        expect(def(4).common.name.en).to.equal('Elapsed time');
    });

    it('laesst die Objekt-IDs unveraendert (Bestandsschutz)', () => {
        expect(def(25).sub).to.equal('heatingEnergy');
        expect(def(26).sub).to.equal('heatingTime');
        expect(def(16).sub).to.equal('energyConsumed');
        expect(def(4).sub).to.equal('remainingTimeInMinutes');
        expect(def(25).kanal).to.equal('process');
    });

    it('fuehrt die neuen Namen in allen elf Sprachen', () => {
        for (const idx of [4, 16, 25, 26]) {
            expect(Object.keys(def(idx).common.name), `F${idx}`).to.have.length(11);
        }
        // Ohne deutsche Namen: die englische Beschriftung, nicht der Feldname
        expect(datenpunkte.definition('2/6195', 'Process', 16, 1, false).common.name).to.equal('Drive energy');
    });
});

describe('Geraetekontext: Verbrauch aus den Lebenszaehlern', () => {
    it('rechnet die Differenz zwischen Programmstart und -ende', () => {
        expect(
            gk.verbrauch({ energieWh: 1467400, wasserL: 20676 }, { energieWh: 1468300, wasserL: 20688 }),
        ).to.deep.equal({ energieWh: 900, wasserL: 12 });
    });

    it('gibt keine Aussage bei fehlendem Stand oder rueckwaerts laufendem Zaehler', () => {
        expect(gk.verbrauch(null, { energieWh: 1, wasserL: 1 })).to.equal(null);
        expect(gk.verbrauch({ energieWh: 5, wasserL: null }, { energieWh: 3, wasserL: 9 })).to.equal(null);
        expect(gk.verbrauch({ energieWh: 5, wasserL: 2 }, { energieWh: 3, wasserL: 9 })).to.deep.equal({
            energieWh: null,
            wasserL: 7,
        });
    });

    it('liest Einheitentyp 46 (EcoEnergyWatt) als Wh - so meldet es die WCR860', () => {
        const a = gk.auswerten(kontextLeaf({ letzteWh: 206, letzteTyp: 46, gesamtWh: 2508477, gesamtTyp: 46 }));
        expect(a.energieLetzteWh).to.equal(206);
        expect(a.energieGesamtWh).to.equal(2508477);
        const d = datenpunkte
            .fuerLeaf('2/1585', kontextLeaf({ gesamtTyp: 46 }), true)
            .find(x => x.sub === 'ecoFeedbackTotalEnergyConsumption');
        expect(d.common.unit).to.equal('Wh');
    });
});
