'use strict';

const { expect } = require('chai');
const { ScanPlaner, LEERLAUF_MS, AUSWEICHEN_MS, MINDEST_MS } = require('../lib/scanplaner');

const TAKT = 25000;
const stillesLog = { info: () => {}, warn: () => {}, debug: () => {} };

/** Ein paar Runden der Ereignisschleife abwarten - die Schleifen laufen mit sofortigem "warten". */
async function runden(n = 50) {
    for (let i = 0; i < n; i++) {
        await new Promise(r => setImmediate(r));
    }
}

/**
 * Ein Planer mit erfundenen Geraeten. `schritte` bestimmt, was jeder Schritt eines Geraets tut;
 * gewartet wird nicht wirklich, jede Pause wird je Geraet mitgeschrieben.
 */
function aufbau(schritte, { schalter } = {}) {
    const an = schalter || Object.fromEntries(Object.keys(schritte).map(id => [id, true]));
    const pausen = {};
    const zaehler = {};
    const gleichzeitig = {};
    const hoechstens = {};
    const beendet = [];
    let stopp = false;
    const planer = new ScanPlaner({
        geraete: () => Object.keys(schritte),
        aktiv: async id => an[id] === true,
        schritt: async id => {
            zaehler[id] = (zaehler[id] || 0) + 1;
            gleichzeitig[id] = (gleichzeitig[id] || 0) + 1;
            hoechstens[id] = Math.max(hoechstens[id] || 0, gleichzeitig[id]);
            try {
                return await schritte[id](zaehler[id]);
            } finally {
                gleichzeitig[id]--;
            }
        },
        beendet: async id => {
            beendet.push(id);
        },
        warten: (ms, id) => {
            (pausen[id] = pausen[id] || []).push(ms);
            return new Promise(r => setImmediate(r));
        },
        stopp: () => stopp,
        log: stillesLog,
        taktMs: TAKT,
    });
    return {
        planer,
        an,
        pausen,
        zaehler,
        hoechstens,
        beendet,
        stoppen: () => {
            stopp = true;
        },
    };
}

describe('Leaf-Scan-Planer: je Geraet ein eigener Takt', () => {
    it('startet fuer jedes Geraet mit gesetztem Schalter eine eigene Schleife', async () => {
        const t = aufbau(
            { wasch: async () => 'gefragt', spuel: async () => 'gefragt', ofen: async () => 'gefragt' },
            { schalter: { wasch: true, spuel: true, ofen: false } },
        );
        const neu = await t.planer.starten();
        expect(neu).to.eql(['wasch', 'spuel']);
        expect(t.planer.laeuft('wasch')).to.equal(true);
        expect(t.planer.laeuft('ofen')).to.equal(false);
        t.stoppen();
        await runden();
    });

    it('startet keine zweite Schleife fuer dasselbe Geraet', async () => {
        const t = aufbau({ wasch: async () => 'gefragt' });
        expect(await t.planer.starten()).to.eql(['wasch']);
        expect(await t.planer.starten()).to.eql([]);
        await runden();
        expect(t.hoechstens.wasch).to.equal(1);
        t.stoppen();
        await runden();
    });

    it('ein haengendes Geraet blockiert die anderen nicht', async () => {
        // Der Backofen: seine Anfrage kommt nie zurueck (oder erst nach Minuten).
        let ofenLoesen;
        const t = aufbau({
            ofen: () => new Promise(r => (ofenLoesen = r)),
            wasch: async () => 'gefragt',
            spuel: async () => 'gefragt',
        });
        await t.planer.starten();
        await runden(100);
        expect(t.zaehler.ofen, 'Ofen bleibt im ersten Schritt').to.equal(1);
        expect(t.zaehler.wasch, 'Waschmaschine kommt voran').to.be.above(5);
        expect(t.zaehler.spuel, 'Spuelmaschine kommt voran').to.be.above(5);
        ofenLoesen('gefragt');
        await runden();
        expect(t.zaehler.ofen, 'Ofen macht danach weiter').to.be.above(1);
        t.stoppen();
        await runden();
    });

    it('fragt dasselbe Geraet nie zweimal gleichzeitig', async () => {
        const t = aufbau({
            wasch: () => new Promise(r => setTimeout(() => r('gefragt'), 2)),
            spuel: () => new Promise(r => setTimeout(() => r('gefragt'), 1)),
        });
        await t.planer.starten();
        await t.planer.starten();
        await new Promise(r => setTimeout(r, 40));
        expect(t.hoechstens.wasch).to.equal(1);
        expect(t.hoechstens.spuel).to.equal(1);
        t.stoppen();
        await new Promise(r => setTimeout(r, 10));
    });

    it('laesst verschiedene Geraete parallel laufen', async () => {
        let gleichzeitig = 0;
        let hoechstens = 0;
        const langsam = () => {
            gleichzeitig++;
            hoechstens = Math.max(hoechstens, gleichzeitig);
            return new Promise(r =>
                setTimeout(() => {
                    gleichzeitig--;
                    r('gefragt');
                }, 5),
            );
        };
        const t = aufbau({ wasch: langsam, spuel: langsam, ofen: langsam });
        await t.planer.starten();
        await new Promise(r => setTimeout(r, 30));
        expect(hoechstens, 'Geraete gleichzeitig in Arbeit').to.equal(3);
        t.stoppen();
        await new Promise(r => setTimeout(r, 20));
    });

    it('haelt nach jeder Anfrage den Takt dieses Geraets ein', async () => {
        const t = aufbau({ wasch: async () => 'gefragt', spuel: async () => 'gefragt' });
        await t.planer.starten();
        await runden();
        t.stoppen();
        await runden();
        for (const id of ['wasch', 'spuel']) {
            expect(t.pausen[id].length, id).to.be.above(3);
            expect(
                t.pausen[id].every(ms => ms === TAKT),
                id,
            ).to.equal(true);
        }
    });

    it('Rueckzug eines Geraets veraendert den Takt der anderen nicht', async () => {
        // Der Ofen sitzt im Rueckzug und meldet, wie lange noch (Zahl), die Waschmaschine fragt.
        const t = aufbau({ ofen: async () => 20 * 60000, wasch: async () => 'gefragt' });
        await t.planer.starten();
        await runden();
        t.stoppen();
        await runden();
        expect(t.pausen.wasch.every(ms => ms === TAKT)).to.equal(true);
        expect(
            t.pausen.ofen.every(ms => ms === LEERLAUF_MS),
            'Ofen schaut spaetestens nach einer Minute wieder',
        ).to.equal(true);
    });

    it('waehlt die Pause nach dem Ergebnis des Schritts', () => {
        const { planer } = aufbau({});
        expect(planer.pauseNach('gefragt')).to.equal(TAKT);
        expect(planer.pauseNach('warten')).to.equal(LEERLAUF_MS);
        expect(planer.pauseNach('ausweichen')).to.equal(AUSWEICHEN_MS);
        expect(planer.pauseNach(12000)).to.equal(12000);
        expect(planer.pauseNach(5)).to.equal(MINDEST_MS);
        expect(planer.pauseNach(10 * 60000)).to.equal(LEERLAUF_MS);
        expect(AUSWEICHEN_MS).to.be.below(TAKT);
    });

    it('beendet nur die Schleife des Geraets, dessen Schalter faellt', async () => {
        const t = aufbau({ wasch: async () => 'gefragt', spuel: async () => 'gefragt' });
        await t.planer.starten();
        await runden(10);
        t.an.wasch = false;
        await runden(20);
        expect(t.beendet).to.eql(['wasch']);
        expect(t.planer.laeuft('wasch')).to.equal(false);
        expect(t.planer.laeuft('spuel')).to.equal(true);
        const vorher = t.zaehler.spuel;
        await runden(20);
        expect(t.zaehler.spuel).to.be.above(vorher);
        t.stoppen();
        await runden();
    });

    it('ein Fehler im Schritt eines Geraets beendet weder diese noch andere Schleifen', async () => {
        const warnungen = [];
        const t = aufbau({
            ofen: async n => {
                if (n === 1) {
                    throw new Error('kaputt');
                }
                return 'gefragt';
            },
            wasch: async () => 'gefragt',
        });
        t.planer.o.log = { ...stillesLog, warn: m => warnungen.push(m) };
        await t.planer.starten();
        await runden();
        expect(warnungen.length).to.equal(1);
        expect(t.zaehler.ofen).to.be.above(1);
        expect(t.zaehler.wasch).to.be.above(1);
        t.stoppen();
        await runden();
    });

    it('endet, wenn der Adapter stoppt', async () => {
        const t = aufbau({ wasch: async () => 'gefragt' });
        await t.planer.starten();
        await runden(5);
        t.stoppen();
        await runden(10);
        expect(t.planer.laeuft('wasch')).to.equal(false);
        expect(await t.planer.starten()).to.eql([]);
    });
});
