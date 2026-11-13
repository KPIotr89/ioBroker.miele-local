'use strict';

/*
 * Der Taktgeber des langsamen Leaf-Scans: JE GERAET EIN EIGENER, UNABHAENGIGER TAKT.
 *
 * WARUM NICHT MEHR EIN PLANER FUER ALLE (bis 13.11.2026 nachmittags)
 * Der erste langsame Scan hatte einen gemeinsamen Planer: reihum hoechstens eine Anfrage je 25 s
 * ueber alle Geraete, nie zwei Geraete gleichzeitig. Das schuetzte jedes Modul - aber es koppelte
 * die Geraete aneinander. Der Backofen H2469BP haengt nach drei bis zehn Anfragen im DOP2 fuer
 * Minuten; jede seiner Anfragen lief dann bis ins Zeitlimit, und Wasch- und Spuelmaschine
 * warteten so lange mit. Entscheid des Nutzers: "abfragen getrennt nach geraet, wenn eines
 * laenger dauert, ist das so".
 *
 * Jedes Geraet hat ein eigenes XKM-Modul mit eigener IP. Was eines ueberfordert, belastet das
 * andere nicht - verschiedene Geraete duerfen also parallel gefragt werden. Was je Geraet gilt,
 * bleibt: hoechstens EINE Scan-Anfrage gleichzeitig (die Schleife wartet jede Antwort ab) und
 * dazwischen der Takt (leafscan.TAKT_MS). Kontrollfrage, Rueckzug, Schonphase, Bremse im Programm
 * und die Absage-Regeln stecken im Schritt (main.js scanSchritt) und haben je Geraet ihren eigenen
 * Zustand.
 *
 * Der Planer selbst kennt weder ioBroker noch Geraete - alles kommt als Funktion herein. So laesst
 * er sich ohne Adapter pruefen (test/scanplaner.js).
 */

/**
 * Wie lange ein Schritt, der nichts gefragt hat, bis zum naechsten Blick wartet. Ein Schritt kann
 * eine kuerzere Wartezeit selbst nennen (Zahl statt 'warten').
 */
const LEERLAUF_MS = 60000;

/**
 * Wartezeit, wenn die normale Abfrage des Geraets gerade laeuft oder ansteht: Der Scan weicht aus
 * und schaut nach dieser Zeit wieder.
 */
const AUSWEICHEN_MS = 5000;

/** Kuerzeste Wartezeit zwischen zwei Schritten eines Geraets. */
const MINDEST_MS = 1000;

/** Je Geraet eine eigene Scan-Schleife - siehe Kopfkommentar. */
class ScanPlaner {
    /**
     * @param {object} o Bausteine
     * @param {() => string[]} o.geraete alle bekannten Geraete-IDs
     * @param {(id: string) => Promise<boolean>} o.aktiv steht der Scan-Schalter dieses Geraets?
     * @param {(id: string) => Promise<'gefragt'|'warten'|'ausweichen'|number>} o.schritt hoechstens eine Anfrage;
     *        eine Zahl nennt die Wartezeit in ms bis zum naechsten Schritt
     * @param {(id: string) => Promise<void>} o.beendet aufraeumen, wenn der Schalter aus ist
     * @param {(ms: number, id: string) => Promise<void>} o.warten Pause (im Adapter this.setTimeout)
     * @param {() => boolean} o.stopp true, sobald der Adapter endet
     * @param {object} o.log ioBroker-Log (info/warn/debug)
     * @param {number} o.taktMs Abstand nach einer Anfrage (leafscan.TAKT_MS)
     * @param {number} [o.leerlaufMs] Abstand nach einem Schritt ohne Anfrage
     * @param {number} [o.ausweichenMs] Abstand, wenn die normale Abfrage gerade dran ist
     */
    constructor(o) {
        this.o = o;
        this.leerlaufMs = o.leerlaufMs || LEERLAUF_MS;
        this.ausweichenMs = o.ausweichenMs || AUSWEICHEN_MS;
        // laufende Schleifen je Geraet: id -> Promise
        this.schleifen = {};
    }

    /**
     * Fuer jedes Geraet mit gesetztem Schalter eine Schleife starten, falls noch keine laeuft.
     *
     * @returns {Promise<string[]>} die Geraete, fuer die eine Schleife neu gestartet wurde
     */
    async starten() {
        const neu = [];
        for (const id of this.o.geraete()) {
            if (this.o.stopp() || this.schleifen[id]) {
                continue;
            }
            let an = false;
            try {
                an = await this.o.aktiv(id);
            } catch {
                an = false;
            }
            if (!an || this.schleifen[id]) {
                continue;
            }
            neu.push(id);
            this.schleifen[id] = this.schleife(id)
                .catch(e => this.o.log.warn(`${id}: leaf scan loop failed - ${e.message}`))
                .finally(() => {
                    delete this.schleifen[id];
                });
        }
        return neu;
    }

    /**
     * @param {string} id Geraete-ID
     * @returns {boolean} laeuft fuer dieses Geraet eine Schleife?
     */
    laeuft(id) {
        return !!this.schleifen[id];
    }

    /**
     * Wie lange nach einem Schritt gewartet wird.
     *
     * @param {'gefragt'|'warten'|'ausweichen'|number} erg Ergebnis des Schritts
     * @returns {number} Millisekunden
     */
    pauseNach(erg) {
        if (erg === 'gefragt') {
            return this.o.taktMs;
        }
        if (erg === 'ausweichen') {
            return this.ausweichenMs;
        }
        if (typeof erg === 'number' && Number.isFinite(erg)) {
            return Math.max(MINDEST_MS, Math.min(erg, this.leerlaufMs));
        }
        return this.leerlaufMs;
    }

    /**
     * Die Schleife eines Geraets: Schritt, Pause, Schritt ... bis der Schalter faellt.
     *
     * @param {string} id Geraete-ID
     */
    async schleife(id) {
        this.o.log.info(
            `${id}: leaf scan (slow) running at its own pace - at most one request every ` +
                `${this.o.taktMs / 1000} s for this appliance, only while the module answers ` +
                '(during a programme at most one per minute)',
        );
        while (!this.o.stopp()) {
            let an = false;
            try {
                an = await this.o.aktiv(id);
            } catch {
                an = false;
            }
            if (!an) {
                await this.o.beendet(id);
                return;
            }
            let erg = 'warten';
            try {
                erg = await this.o.schritt(id);
            } catch (e) {
                this.o.log.warn(`${id}: leaf scan step failed - ${e.message}`);
            }
            if (this.o.stopp()) {
                return;
            }
            await this.o.warten(this.pauseNach(erg), id);
        }
    }
}

module.exports = { ScanPlaner, LEERLAUF_MS, AUSWEICHEN_MS, MINDEST_MS };
