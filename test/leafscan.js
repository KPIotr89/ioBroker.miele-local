'use strict';

const { expect } = require('chai');
const ls = require('../lib/leafscan');

describe('Leaf-Scan: Adressen', () => {
    it('geht die Bereiche vollstaendig durch', () => {
        const a = ls.adressen([{ unit: 2, von: 10, bis: 13 }]);
        expect(a).to.deep.equal([
            { unit: 2, attr: 10 }, { unit: 2, attr: 11 },
            { unit: 2, attr: 12 }, { unit: 2, attr: 13 },
        ]);
    });

    it('schliesst die vier bekannten Leafs ein', () => {
        // 2/119 Betriebsstunden, 2/256 Zeiten, 2/1583 Benutzeranfrage, 2/6195 EcoFeedback.
        // Waeren sie nicht dabei, taugte der Scan nicht als Gegenprobe.
        const alle = new Set(ls.adressen().map(a => ls.schluessel(a.unit, a.attr)));
        for (const bekannt of ['2/119', '2/256', '2/1583', '2/6195']) {
            expect(alle.has(bekannt), bekannt).to.be.true;
        }
    });

    it('bleibt in einer Groessenordnung, die ein Geraet vertraegt', () => {
        // Bei 700 ms Pause sind 700 Adressen rund acht Minuten reine Wartezeit - vertretbar.
        // Ein Scan ueber alle 65535 Attribute waere es nicht.
        expect(ls.adressen().length).to.be.below(1000);
    });
});

describe('Leaf-Scan: langsamer Planer - welche Adresse als naechste', () => {
    const bereiche = [{ unit: 2, von: 1, bis: 10 }];
    const T = 1_000_000_000_000;

    it('faengt vorn an, wenn noch nichts da ist', () => {
        expect(ls.naechsteAdresse({}, T, bereiche)).to.deep.equal({ unit: 2, attr: 1 });
    });

    it('setzt hinter dem Bestaetigten fort - ein Abbruch kostet nichts', () => {
        let erg = {};
        for (let a = 1; a <= 4; a++) {
            erg = ls.einordnen(erg, 2, a, { status: 404 }, { wach: true, jetzt: T });
        }
        expect(ls.naechsteAdresse(erg, T + 1000, bereiche)).to.deep.equal({ unit: 2, attr: 5 });
    });

    it('fragt alte 500er aus Schlafphasen erneut, in der Reihenfolge der Bereiche', () => {
        // 2/1585 stand bis 13.11.2026 als 500/404 im Ergebnis und antwortet heute mit Daten.
        const erg = { '2/1': { antwortet: false, status: 404 }, '2/2': { antwortet: false, status: 500 } };
        expect(ls.naechsteAdresse(erg, T, bereiche)).to.deep.equal({ unit: 2, attr: 2 });
        expect(ls.endgueltig(erg['2/2'])).to.equal(false);
    });

    it('zaehlt ein altes 404 als eine Bestaetigung, ein altes 500 als keine', () => {
        expect(ls.bestaetigungen({ antwortet: false, status: 404 })).to.equal(1);
        expect(ls.bestaetigungen({ antwortet: false, status: 500 })).to.equal(0);
        expect(ls.endgueltig({ antwortet: false, status: 404 })).to.equal(false);
    });

    it('bestaetigt erst nach dem Mindestabstand ein zweites Mal', () => {
        let erg = {};
        for (let a = 1; a <= 10; a++) {
            erg = ls.einordnen(erg, 2, a, { status: 404 }, { wach: true, jetzt: T });
        }
        expect(ls.naechsteAdresse(erg, T + 60000, bereiche), 'zu frueh').to.equal(null);
        const spaeter = T + ls.BESTAETIGUNG_ABSTAND_MS + 1;
        expect(ls.naechsteAdresse(erg, spaeter, bereiche)).to.deep.equal({ unit: 2, attr: 1 });
        erg = ls.einordnen(erg, 2, 1, { status: 404 }, { wach: true, jetzt: spaeter });
        expect(ls.endgueltig(erg['2/1'])).to.equal(true);
        expect(ls.fortschritt(erg, bereiche).fertig).to.equal(1);
    });

    it('ist fertig, wenn alles bestaetigt ist', () => {
        let erg = {};
        for (let a = 1; a <= 10; a++) {
            erg = ls.einordnen(erg, 2, a, { status: 404 }, { wach: true, jetzt: T });
            erg = ls.einordnen(erg, 2, a, { status: 404 }, { wach: true, jetzt: T + ls.BESTAETIGUNG_ABSTAND_MS });
        }
        expect(ls.naechsteAdresse(erg, T + 2 * ls.BESTAETIGUNG_ABSTAND_MS, bereiche)).to.equal(null);
        expect(ls.fortschritt(erg, bereiche).text).to.match(/done/);
    });
});

describe('Leaf-Scan: langsamer Planer - Absagen einordnen', () => {
    const T = 1_000_000_000_000;

    it('laesst eine gueltige 404-Bestaetigung von einem unbelegten 500 unberuehrt', () => {
        let erg = ls.einordnen({}, 2, 9, { status: 404 }, { wach: true, jetzt: T });
        erg = ls.einordnen(erg, 2, 9, { status: 500 }, { wach: false, jetzt: T + 1 });
        expect(erg['2/9'].status).to.equal(404);
        expect(ls.bestaetigungen(erg['2/9'])).to.equal(1);
    });

    it('zaehlt ein 500 nur mit Wachbeleg', () => {
        const ohne = ls.einordnen({}, 2, 9, { status: 500 }, { wach: false, jetzt: T });
        expect(ls.bestaetigungen(ohne['2/9'])).to.equal(0);
        const mit = ls.einordnen({}, 2, 9, { status: 500 }, { wach: true, jetzt: T });
        expect(ls.bestaetigungen(mit['2/9'])).to.equal(1);
    });

    it('fragt ein unbelegtes 500 nicht im Takt erneut', () => {
        const erg = ls.einordnen({}, 2, 1, { status: 500 }, { wach: false, jetzt: T });
        const b = [{ unit: 2, von: 1, bis: 1 }];
        expect(ls.naechsteAdresse(erg, T + 60000, b)).to.equal(null);
        expect(ls.naechsteAdresse(erg, T + ls.WIEDERHOLUNG_MS + 1, b)).to.deep.equal({ unit: 2, attr: 1 });
    });

    it('beginnt die Zaehlung neu, wenn sich der Status aendert', () => {
        let erg = ls.einordnen({}, 2, 9, { status: 500 }, { wach: true, jetzt: T });
        erg = ls.einordnen(erg, 2, 9, { status: 404 }, { wach: true, jetzt: T + ls.BESTAETIGUNG_ABSTAND_MS });
        expect(ls.bestaetigungen(erg['2/9'])).to.equal(1);
    });

    it('nimmt einen Treffer sofort und merkt sich den alten Status', () => {
        const erg = ls.einordnen(
            { '2/1585': { antwortet: false, status: 500 } },
            2,
            1585,
            { felder: { 1: 7 } },
            { wach: true, jetzt: T },
        );
        expect(erg['2/1585'].antwortet).to.equal(true);
        expect(erg['2/1585'].vorher).to.equal(500);
        expect(ls.endgueltig(erg['2/1585'])).to.equal(true);
    });

    it('legt eine Adresse, die immer wieder stoert, nach drei Stoerungen still', () => {
        let erg = {};
        for (let i = 0; i < ls.STOERUNGEN_JE_ADRESSE; i++) {
            expect(ls.endgueltig(erg['14/1570']), `${i}`).to.not.equal(true);
            erg = ls.einordnen(erg, 14, 1570, { status: 'Fehler: Timeout x' }, { wach: true, jetzt: T + i });
        }
        expect(ls.endgueltig(erg['14/1570'])).to.equal(true);
        expect(erg['14/1570'].antwortet).to.equal(false);
    });

    it('vermerkt 503 bei wachem Modul an der Adresse und laesst sie nach drei Mal liegen', () => {
        // Backofen 13.11.2026: 14/1566-1569 404, 14/1570 503 - der Scan darf dort nicht haengen.
        let erg = {};
        for (let i = 0; i < ls.STOERUNGEN_JE_ADRESSE; i++) {
            erg = ls.einordnen(erg, 14, 1570, { status: 503 }, { wach: true, jetzt: T + i, besetztJeAdresse: true });
        }
        expect(ls.endgueltig(erg['14/1570'])).to.equal(true);
        const b = [{ unit: 14, von: 1570, bis: 1571 }];
        const eins = ls.einordnen({}, 14, 1570, { status: 503 }, { wach: true, jetzt: T, besetztJeAdresse: true });
        expect(ls.naechsteAdresse(eins, T + 1000, b)).to.deep.equal({ unit: 14, attr: 1571 });
    });

    it('legt fuer 503 nichts ab', () => {
        // Der Planer behandelt 503 vorher; einordnen darf es trotzdem nicht als Absage zaehlen.
        const erg = ls.einordnen({}, 2, 1, { status: 503 }, { wach: true, jetzt: T });
        expect(erg['2/1']).to.equal(undefined);
    });
});

describe('Leaf-Scan: langsamer Planer - Tempo und Schutz', () => {
    it('fragt hoechstens alle 20-30 Sekunden', () => {
        expect(ls.TAKT_MS).to.be.within(20000, 30000);
    });

    it('zieht sich nach Stoerungen immer laenger zurueck, 5 bis 30 Minuten', () => {
        expect(ls.rueckzugMs(1)).to.equal(5 * 60000);
        expect(ls.rueckzugMs(2)).to.equal(10 * 60000);
        expect(ls.rueckzugMs(3)).to.equal(20 * 60000);
        expect(ls.rueckzugMs(9)).to.equal(30 * 60000);
    });

    it('verzeiht Stoerungen erst nach einer stoerungsfreien Schonphase, nicht nach einer guten Antwort', () => {
        const jetzt = 1e12;
        expect(ls.fehlerVerzeihen(undefined, jetzt)).to.equal(true);
        expect(ls.fehlerVerzeihen(0, jetzt)).to.equal(true);
        expect(ls.fehlerVerzeihen(jetzt + 60000, jetzt)).to.equal(false);
        expect(ls.fehlerVerzeihen(jetzt - 1, jetzt)).to.equal(true);
    });

    it('scannt nicht bei gewaehltem, pausiertem, gestoertem oder unbekanntem Zustand', () => {
        for (const st of [3, 4, 6, 8, 9, 255, null]) {
            expect(ls.scanErlaubt({ status: st, seitMs: 3600000, verbunden: true }), String(st)).to.equal(false);
        }
    });

    it('scannt im Programm nur gebremst und erst nach zehn Minuten', () => {
        expect(ls.scanErlaubt({ status: 5, seitMs: 300000, verbunden: true })).to.equal(false);
        expect(ls.scanErlaubt({ status: 5, seitMs: 900000, verbunden: true })).to.equal('betrieb');
        expect(ls.BETRIEB_ABSTAND_MS).to.be.at.least(60000);
    });

    it('scannt im Aus/Ein/Ende erst nach einer Ruhezeit', () => {
        expect(ls.scanErlaubt({ status: 1, seitMs: 60000, verbunden: true })).to.equal(false);
        expect(ls.scanErlaubt({ status: 1, seitMs: 600000, verbunden: true })).to.equal('ruhe');
        expect(ls.scanErlaubt({ status: 2, seitMs: 600000, verbunden: true })).to.equal('ruhe');
        expect(ls.scanErlaubt({ status: 7, seitMs: 60000, verbunden: true })).to.equal(false);
        expect(ls.scanErlaubt({ status: 7, seitMs: 180000, verbunden: true })).to.equal('ruhe');
    });

    it('scannt nicht, wenn die normale Abfrage das Geraet nicht erreicht', () => {
        expect(ls.scanErlaubt({ status: 1, seitMs: 3600000, verbunden: false })).to.equal(false);
    });
});

describe('Leaf-Scan: Ergebnisse', () => {
    it('merkt sich die Feldwerte, nicht nur die Anzahl', () => {
        // Ohne die Werte muesste jedes gefundene Leaf noch einmal von Hand angesehen werden.
        const erg = ls.aufnehmen({}, 2, 6195, { felder: { 21: 13341, 25: 319 } });
        expect(erg['2/6195'].felder['21']).to.equal(13341);
        expect(erg['2/6195'].anzahl).to.equal(2);
    });

    it('haelt eine Absage als Absage fest', () => {
        // Auch ein 500er ist ein Ergebnis - sonst wird die Adresse ewig neu gefragt.
        const erg = ls.aufnehmen({}, 2, 999, { status: 500 });
        expect(erg['2/999'].antwortet).to.be.false;
        expect(erg['2/999'].status).to.equal(500);
    });

    it('wertet ein leeres Leaf nicht als Treffer', () => {
        const erg = ls.aufnehmen({}, 2, 5, { felder: {} });
        expect(erg['2/5'].antwortet).to.be.false;
    });

    it('sortiert die Treffer nach Feldzahl', () => {
        let erg = {};
        erg = ls.aufnehmen(erg, 2, 100, { felder: { 1: 1 } });
        erg = ls.aufnehmen(erg, 2, 200, { felder: { 1: 1, 2: 2, 3: 3 } });
        erg = ls.aufnehmen(erg, 2, 300, { status: 500 });
        expect(ls.treffer(erg)).to.deep.equal([
            { leaf: '2/200', felder: 3 }, { leaf: '2/100', felder: 1 },
        ]);
    });
});

describe('Leaf-Scan: Unterschiede zwischen zwei Scans', () => {
    /*
     * DER EIGENTLICHE ZWECK. Ein Leaf mit vierzig Feldern sagt fuer sich nichts. Erst zwei
     * Scans - einer im Leerlauf, einer waehrend eines Programms - zeigen, welche Felder
     * sich mit der Maschine bewegen. Genau diese sind die Kandidaten fuer Energie, TwinDos
     * und alles andere, was noch fehlt.
     */
    const leerlauf = {
        '2/6195': { antwortet: true, felder: { 21: 0, 25: 0, 99: 7 }, anzahl: 3 },
        '2/300': { antwortet: true, felder: { 1: 'W1' }, anzahl: 1 },
    };
    const imLauf = {
        '2/6195': { antwortet: true, felder: { 21: 13341, 25: 319, 99: 7 }, anzahl: 3 },
        '2/300': { antwortet: true, felder: { 1: 'W1' }, anzahl: 1 },
    };

    it('findet genau die Felder, die sich bewegt haben', () => {
        const u = ls.unterschiede(leerlauf, imLauf);
        expect(u).to.have.lengthOf(2);
        expect(u.map(x => x.feld).sort()).to.deep.equal(['21', '25']);
    });

    it('nennt alten und neuen Wert', () => {
        const u = ls.unterschiede(leerlauf, imLauf).find(x => x.feld === '21');
        expect(u.von).to.equal(0);
        expect(u.bis).to.equal(13341);
        expect(u.leaf).to.equal('2/6195');
    });

    it('uebergeht, was gleich geblieben ist', () => {
        // Feld 99 und das ganze Leaf 2/300 - Konfiguration und Geraetebeschreibung.
        const felder = ls.unterschiede(leerlauf, imLauf).map(x => x.feld);
        expect(felder).to.not.include('99');
        expect(ls.unterschiede(leerlauf, imLauf).map(x => x.leaf)).to.not.include('2/300');
    });

    it('verkraftet ein Leaf, das nur in einem der beiden Scans antwortet', () => {
        // Ein schlafendes Geraet antwortet auf manches nicht - das ist kein Unterschied,
        // sondern eine Luecke, und darf nicht als Bewegung gezaehlt werden.
        const halb = { '2/6195': { antwortet: false, status: 500 } };
        expect(ls.unterschiede(halb, imLauf)).to.be.empty;
        expect(ls.unterschiede(leerlauf, halb)).to.be.empty;
    });

    it('verkraftet leere Eingaben', () => {
        expect(ls.unterschiede(null, null)).to.be.empty;
        expect(ls.unterschiede({}, imLauf)).to.be.empty;
    });
});

describe('Leaf-Scan: Ueberlastung erkennen', () => {
    /*
     * Am 04.09.2026 warf die Waschmaschine nach rund 170 Adressen ihre Verbindung ab -
     * lokal und zur Cloud, beide kamen von selbst nicht zurueck. Die Vorboten standen im
     * Ergebnis: 23 abgebrochene Sockets und ein Dutzend Zeitueberschreitungen zwischen
     * ansonsten sauberen Absagen mit Status 101.
     */
    it('erkennt einen abgebrochenen Socket als Stoerung', () => {
        expect(ls.ueberlastet({ status: 'Fehler: socket hang up' })).to.be.true;
    });

    it('erkennt eine Zeitueberschreitung als Stoerung', () => {
        expect(ls.ueberlastet({ status: 'Fehler: Timeout 192.168.10.127/Devices/…' })).to.be.true;
    });

    it('haelt eine saubere Absage NICHT fuer eine Stoerung', () => {
        // 101 ist die haeufigste Antwort des Moduls auf "gibt es nicht" - wer die als
        // Stoerung zaehlt, bricht den Scan nach der ersten Handvoll Adressen ab.
        expect(ls.ueberlastet({ status: 101 })).to.be.false;
        expect(ls.ueberlastet({ status: 500 })).to.be.false;
        expect(ls.ueberlastet({ status: 404 })).to.be.false;
    });

    it('haelt einen Treffer nicht fuer eine Stoerung', () => {
        expect(ls.ueberlastet({ felder: { 1: 5 } })).to.be.false;
        expect(ls.ueberlastet(null)).to.be.false;
    });

    it('gibt dem Geraet genug Luft zwischen zwei Anfragen', () => {
        // Zwei Sekunden - siehe den Vorfall oben. 400 ms waren zu wenig.
        expect(ls.PAUSE_MS).to.be.at.least(2000);
    });
});

describe('Leaf-Scan: Antwort gegen Stoerung', () => {
    /*
     * DER FEHLER, DER DEN ZWEITEN SCANLAUF WERTLOS MACHTE.
     *
     * Am 04.09.2026 lief er, waehrend die Maschine wusch. Von 239 unbeantworteten Adressen
     * kamen 132 mit HTTP 503 zurueck und 46 mit abgebrochener Verbindung. Alles wurde als
     * "geprueft" abgelegt - und damit Adressen abgehakt, die nie wirklich gefragt wurden.
     * Zwei Leafs, die im ersten Lauf Daten geliefert hatten (2/122 und 2/123), standen
     * danach als erledigt im Ergebnis.
     */
    it('haelt 503 nicht fuer eine Antwort', () => {
        expect(ls.beantwortet({ status: 503 })).to.be.false;
        expect(ls.ueberlastet({ status: 503 })).to.be.true;
    });

    it('haelt eine echte Absage fuer eine Antwort', () => {
        // 101 ist die normale "gibt es nicht"-Antwort des Moduls, 404 und 500 ebenso.
        for (const st of [101, 404, 500]) {
            expect(ls.beantwortet({ status: st }), String(st)).to.be.true;
            expect(ls.ueberlastet({ status: st }), String(st)).to.be.false;
        }
    });

    it('haelt einen abgebrochenen Socket nicht fuer eine Antwort', () => {
        expect(ls.beantwortet({ status: 'Fehler: socket hang up' })).to.be.false;
        expect(ls.beantwortet({ status: 'Fehler: connect ECONNREFUSED 192.168.10.127:80' })).to.be.false;
        expect(ls.beantwortet({ status: 'Fehler: Parse Error: Expected HTTP/' })).to.be.false;
    });

    it('haelt gelieferte Felder immer fuer eine Antwort', () => {
        expect(ls.beantwortet({ felder: { 1: 5 } })).to.be.true;
    });

    it('haelt gar nichts nicht fuer eine Antwort', () => {
        expect(ls.beantwortet(null)).to.be.false;
        expect(ls.beantwortet({})).to.be.false;
    });
});

describe('Leaf-Scan: Reihenfolge', () => {
    /*
     * WARUM DAS GEPRUEFT WIRD. Bis zum 05.09.2026 stand Unit 1 vorn, und der Scan kam nie
     * darueber hinaus: 20 von 882 Adressen geprueft, alle in einem Bereich, der nachweislich
     * nicht antwortet. Die Reihenfolge ist hier kein Schoenheitsfehler, sondern entscheidet,
     * ob der Scan je etwas findet.
     */
    it('faengt bei den bekannten Leafs an, nicht bei Unit 1', () => {
        const ersten = ls.adressen().slice(0, 40);
        expect(ersten.every(a => a.unit === 2), 'die ersten 40 Adressen liegen in Unit 2')
            .to.be.true;
    });

    it('beginnt am EcoFeedback', () => {
        expect(ls.naechsteAdresse({}, Date.now())).to.deep.equal({ unit: 2, attr: 6100 });
    });

    it('stellt Unit 14 ans Ende - dort knickten die EK037-Module ein', () => {
        const alle = ls.adressen();
        expect(alle[alle.length - 1].unit).to.equal(14);
    });

    it('gibt Unit 1 und 3 nicht auf, stellt sie nur zurueck', () => {
        const alle = new Set(ls.adressen().map(a => ls.schluessel(a.unit, a.attr)));
        expect(alle.has('1/1'), '1/1').to.be.true;
        expect(alle.has('3/1'), '3/1').to.be.true;
    });
});

describe('Leaf-Scan: Geduld statt Abbruch', () => {
    /*
     * WARUM DAS ZAEHLT. Am 05.09.2026 stand der Scan seit vier Wochen bei 23 von 882
     * Adressen. Der Grund war nicht das Geraet, sondern die Behandlung seiner Antwort:
     * Waehrend eines Programms sagt das Modul fast jede Anfrage mit 503 ab, und fuenf davon
     * in Folge beendeten den Durchgang. Ein 503 ist aber eine Antwort - das Modul hat gehoert
     * und bittet um Geduld.
     */
    it('haelt 503 fuer beschaeftigt, nicht fuer gestoert', () => {
        expect(ls.beschaeftigt({ status: 503 })).to.be.true;
        expect(ls.beschaeftigt({ status: '503' })).to.be.true;
    });

    it('haelt einen Verbindungsabbruch NICHT fuer blosse Beschaeftigung', () => {
        // Hier ist Abbrechen richtig - so kuendigte sich der Ausfall vom 04.09.2026 an.
        expect(ls.beschaeftigt({ status: 'Fehler: socket hang up' })).to.be.false;
        expect(ls.beschaeftigt({ status: 'Fehler: Timeout' })).to.be.false;
        expect(ls.beschaeftigt({ status: 101 })).to.be.false;
    });

    it('haelt eine Absage weiterhin nicht fuer eine Antwort', () => {
        // Sonst waere die Adresse abgehakt, ohne je gefragt worden zu sein.
        expect(ls.beantwortet({ status: 503 })).to.be.false;
    });
});

describe('Leaf-Scan: Start beim Einschalten', () => {
    const lage = (x) => ({ an: true, vorher: 1, nachher: 7, schalter: false, geprueft: false, ...x });

    it('startet, wenn ein nie durchsuchtes Geraet eingeschaltet wird', () => {
        expect(ls.beimEinschaltenStarten(lage())).to.be.true;
    });

    it('startet nicht, wenn die Automatik aus ist', () => {
        expect(ls.beimEinschaltenStarten(lage({ an: false }))).to.be.false;
    });

    it('startet nicht beim Ausschalten', () => {
        expect(ls.beimEinschaltenStarten(lage({ vorher: 7, nachher: 1 }))).to.be.false;
    });

    it('startet nicht, wenn das Geraet schon an war', () => {
        // Ein Statuswechsel mitten im Betrieb ist kein Einschalten.
        expect(ls.beimEinschaltenStarten(lage({ vorher: 5, nachher: 7 }))).to.be.false;
    });

    it('startet auch ohne bekannten Vorzustand', () => {
        // Nach einem Adapterstart steht dort nichts - das darf nicht blockieren.
        expect(ls.beimEinschaltenStarten(lage({ vorher: null }))).to.be.true;
    });

    it('startet nicht, wenn die Suche schon laeuft', () => {
        expect(ls.beimEinschaltenStarten(lage({ schalter: true }))).to.be.false;
    });

    it('ueberstimmt keine Entscheidung des Nutzers', () => {
        // Wer abgeschaltet hat, hat schon Adressen im Ergebnis - dann bleibt es aus.
        expect(ls.beimEinschaltenStarten(lage({ geprueft: true }))).to.be.false;
    });
});

describe('Leaf-Scan: Kontrollfrage, die nie antwortet', () => {
    /*
     * Kennt ein Geraet den Adressbereich der Kontrolladresse nicht, antwortet es mit 500 - von
     * "beschaeftigt" nicht zu unterscheiden. Ohne Rueckfall wuerde es nie gescannt.
     */
    it('wartet, solange die Grenze nicht erreicht ist', () => {
        expect(ls.trotzdemVersuchen({ kennt: false, taub: 3, grenze: 10 })).to.be.false;
    });

    it('wagt es nach der Grenze', () => {
        expect(ls.trotzdemVersuchen({ kennt: false, taub: 10, grenze: 10 })).to.be.true;
    });

    it('wagt nichts bei einem Geraet, das die Adresse kennt', () => {
        // Dort heisst ein 500 wirklich "gerade nicht" - das ist zu respektieren.
        expect(ls.trotzdemVersuchen({ kennt: true, taub: 99, grenze: 10 })).to.be.false;
    });
});

describe('Leaf-Scan: Antwort mit Parse-Fehler', () => {
    // Bis 0.5.2 blieb eine solche Adresse offen ("Fehler: Unknown DOP2 field type 33" ist kein
    // Status), und der Scan wurde nie fertig - an der WWG760 bei 2/1585 gesehen.
    const ergebnis = { status: 200, fehler: 'Unknown DOP2 field type 34 @40', roh: '00aa' };

    it('zaehlt als beantwortet', () => {
        expect(ls.beantwortet(ergebnis)).to.equal(true);
        expect(ls.ueberlastet(ergebnis)).to.equal(false);
    });

    it('legt Status numerisch und Fehlertext getrennt ab - und die Adresse ist erledigt', () => {
        const erg = ls.aufnehmen({}, 2, 1585, ergebnis);
        expect(erg['2/1585']).to.deep.equal({
            antwortet: true,
            status: 200,
            fehler: 'Unknown DOP2 field type 34 @40',
            felder: {},
            anzahl: 0,
            roh: '00aa',
        });
        expect(ls.endgueltig(erg['2/1585'])).to.equal(true);
        expect(ls.fortschritt(erg).gefunden).to.equal(1);
    });
});

describe('Leaf-Scan: Export ohne Kennungen', () => {
    const SERIE = '000111111111';
    const scan = {
        '2/145': { antwortet: true, felder: { 1: SERIE, 2: '65', 3: 'G5840', 4: '11223344' }, anzahl: 4 },
        '14/1565': { antwortet: true, felder: { 1: '001D63FFFEAAA2DC' }, anzahl: 1 },
        '14/1566': { antwortet: true, felder: { 1: 12345678, 2: [1, 2, 3] }, anzahl: 2 },
        '14/1571': { antwortet: true, felder: { 17: 'mac-001D63FFFEAAA2DC', 2: true }, anzahl: 2 },
        '14/1573': { antwortet: true, felder: { 2: [192, 168, 30, 80], 9: 'Mein-WLAN' }, anzahl: 2 },
        '2/119': { antwortet: true, felder: { 1: 439713 }, anzahl: 1 },
        '2/256': { antwortet: true, felder: { 3: `Datei ${SERIE}.bin`, 4: '00:1d:63:aa:bb:cc' }, anzahl: 2 },
        '2/1585': { antwortet: true, status: 200, fehler: 'x', felder: {}, anzahl: 0, roh: Buffer.from(SERIE).toString('hex') },
        '2/1586': { antwortet: false, status: 404 },
    };

    it('maskiert Seriennummer, Modulnummer, MAC, IP und WLAN-Namen', () => {
        const a = ls.anonymisieren(scan, [SERIE]);
        const text = JSON.stringify(a);
        expect(text).to.not.include(SERIE);
        expect(text).to.not.include('Mein-WLAN');
        expect(text).to.not.include('1D63');
        expect(text).to.not.include('12345678');
        expect(a['14/1573'].felder[2], 'Aufbau bleibt sichtbar').to.deep.equal(['***', '***', '***', '***']);
        expect(a['14/1571'].felder[2], 'Wahrheitswerte verraten nichts').to.equal(true);
        expect(a['2/256'].felder[4]).to.equal('***');
        expect(a['2/1585'].roh).to.equal('***');
        expect(a['14/1565'].felder[1], 'EUI/MAC 14/1565').to.equal('***');
    });

    it('laesst alles andere unveraendert und das Original unberuehrt', () => {
        const a = ls.anonymisieren(scan, [SERIE]);
        expect(a['2/119']).to.deep.equal(scan['2/119']);
        expect(a['2/1586']).to.deep.equal(scan['2/1586']);
        expect(scan['2/145'].felder[1]).to.equal(SERIE);
    });
});
