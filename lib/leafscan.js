'use strict';

/*
 * Systematisch durchsuchen, welche DOP2-Leafs ein Geraet ueberhaupt beantwortet.
 *
 * WOZU
 * Der Adapter kennt bis 0.3.15 genau vier Leafs: 2/119 (Betriebsstunden), 2/256 (Rest- und
 * Laufzeit), 2/1583 (Benutzeranfrage) und 2/6195 (EcoFeedback). Woher die stammen, ist
 * nicht dokumentiert - sie wurden aus fremden Projekten uebernommen und am Geraet
 * bestaetigt. Was daneben noch antwortet, weiss niemand.
 *
 * Am 04.09.2026 wurde das zum Problem: In 2/6195 traegt KEIN Feld die verbrauchte Energie.
 * Geprueft wurden alle 47 Felder, in vier Ableitungen (Endwert, Differenz, Maximum,
 * Spanne), gegen die Shelly-Messung ueber neun Waschgaenge - das beste Feld lag 51 Prozent
 * daneben. Wenn die Zahl irgendwo im Geraet steht, dann in einem anderen Leaf.
 *
 * SCHONEND, WEIL DAS GERAET EMPFINDLICH IST
 * Ein Miele-Modul beantwortet immer nur EINE Verbindung; zwei gleichzeitige Anfragen
 * bringen es aus dem Tritt (deshalb die Warteschlange in lib/api.js). Ein Scan ueber
 * hunderte Adressen ist deshalb kein Sprint: Zwischen den Anfragen liegt eine Pause, der
 * Fortschritt wird nach jedem Schritt gesichert, und ein Abbruch kostet nichts - beim
 * naechsten Mal geht es an derselben Stelle weiter.
 *
 * WAS NICHT GESCANNT WIRD: nichts Schreibendes. Der Scan liest ausschliesslich; eine
 * unbekannte Adresse zu BESCHREIBEN koennte ein Geraet verstellen, und das waere ein sehr
 * teurer Weg, etwas herauszufinden.
 */

/**
 * Wo gesucht wird.
 *
 * Die Bereiche sind nicht geraten, sondern um die vier bekannten Adressen herum gelegt:
 * DOP2-Leafs treten in Gruppen auf, und was neben 119, 256, 1583 und 6195 liegt, gehoert
 * meist zur selben Funktionsgruppe. Unit 1 und 3 kommen dazu, weil dort bei anderen
 * Miele-Baureihen die Geraete- und Konfigurationsdaten liegen.
 */
const BEREICHE = [
    /*
     * DIE REIHENFOLGE IST DIE AUSSICHT AUF ERFOLG, nicht die Nummer.
     *
     * Bis zum 05.09.2026 stand Unit 1 vorn - und der Scan kam nie darueber hinaus: Nach vier
     * Wochen standen 20 von 882 Adressen als geprueft, alle aus Unit 1, alle ohne Antwort.
     * Ein Durchgang umfasst 40 Adressen und laeuft nur, wenn die Maschine wach ist; wer die
     * ersten 80 davon auf einen Bereich verwendet, der nachweislich schweigt, kommt nie an
     * die Stelle, an der etwas zu holen waere.
     *
     * Deshalb zuerst die Umgebung der vier bekannten Leafs (alle in Unit 2), dann der Rest.
     * Unit 1 und 3 bleiben hinten - sie werden nicht aufgegeben, nur zurueckgestellt.
     */
    { unit: 2, von: 6100, bis: 6300, was: 'around the EcoFeedback' },
    { unit: 2, von: 1500, bis: 1700, was: 'around the user request' },
    { unit: 2, von: 1, bis: 400, was: 'state and times' },
    { unit: 1, von: 1, bis: 40, was: 'device data' },
    { unit: 3, von: 1, bis: 40, was: 'configuration' },
    /*
     * UNIT 14 - die Programmlisten der Gargeraete.
     *
     * AM 15.09.2026 DAZUGEKOMMEN, und zwar aus einem konkreten Anlass: Der Backofen H2469BP
     * dieses Haushalts beantwortete ALLE 882 bis dahin gescannten Adressen mit 404. Kein
     * einziges Leaf, in drei Units. Das sah nach einem Geraet aus, das lokal nichts hergibt.
     *
     * `ha-miele-at-lan` nennt aber zwei Adressen, die in keiner der drei Units liegen:
     * 14/1570 (Programmliste des Backofens, alte Anordnung) und 14/1571 (Optionsliste zum
     * gewaehlten Programm). Ein Geraet, das an der falschen Stelle gefragt wird, schweigt
     * nicht aus Unvermoegen.
     *
     * Der Bereich ist bewusst eng: 1560 bis 1600 sind vierzig Adressen, also ein Durchgang.
     * Weiter zu suchen, waere Raten - und Raten kostet bei fuenf Sekunden je Adresse Zeit,
     * die das Modul fuer seine eigene Arbeit braucht.
     */
    { unit: 14, von: 1560, bis: 1600, was: 'program lists of cooking appliances' },
];

/**
 * Pause zwischen zwei Anfragen.
 *
 * WARUM SO LANG. Am 04.09.2026 mit 400 ms gefahren - nach rund 170 Adressen warf das
 * WLAN-Modul der Waschmaschine die Verbindung ab, lokal UND zur Cloud. Der Waschgang lief
 * weiter (das Modul haengt nicht am Programm), aber beide Anbindungen waren weg und kamen
 * von selbst nicht zurueck. Vorboten standen im Ergebnis: 23 "socket hang up" und ein
 * Dutzend Timeouts, waehrend die uebrigen Adressen sauber mit 101 absagten.
 *
 * Zwei Sekunden sind fuer einen Scan ueber 882 Adressen viel - rund eine halbe Stunde. Das
 * ist der Preis dafuer, dass ein Geraet, das nur eine Verbindung bedient, nebenher noch
 * seine eigentliche Arbeit tun kann.
 *
 * AM 07.09.2026 AUF FUENF SEKUNDEN ERHOEHT. Waehrend beide Maschinen liefen, brach jeder
 * Durchgang nach wenigen Adressen mit Verbindungsstoerungen ab - und die Waschmaschine
 * beantwortete daraufhin nicht einmal mehr ihr eigenes Eco-Leaf. Entscheidend ist die
 * Dichte der Anfragen, nicht ihre Gesamtzahl: Nach etwa einer Minute Ruhe ist das Modul
 * wieder ansprechbar, unter Dauerfeuer bleibt es stumm. Ein langsamer Scan, der durchlaeuft,
 * ist besser als ein schneller, der abbricht und von vorn anfaengt.
 */
const PAUSE_MS = 5000;

/*
 * DER LANGSAME SCAN (seit 13.11.2026)
 *
 * Bis 0.5.2 lief der Scan in Durchgaengen zu vierzig Adressen mit fuenf Sekunden Abstand, je
 * Geraet eine eigene Schleife. Am 13.11.2026 hat genau das die EK037-Module (Wasch- und
 * Spuelmaschine) im Bereich Unit 14 ueberfordert: Die Waschmaschine lehnte Verbindungen ab
 * (ECONNREFUSED), die Spuelmaschine war rund eine Minute gar nicht erreichbar - auch fuer die
 * normale Abfrage. Ausserdem stand ein Grossteil der Ergebnisse auf "500", gesammelt in
 * Phasen, in denen das Modul schlief: 2/1585 galt als 404/500 und antwortet heute mit Daten.
 *
 * Jetzt gilt:
 *  - Je Geraet ein eigener, unabhaengiger Takt (lib/scanplaner.js): hoechstens eine Anfrage je
 *    TAKT_MS (Kontrollfrage eingeschlossen), nie zwei gleichzeitig an dasselbe Geraet. Bis zum
 *    Abend des 13.11.2026 gab es einen gemeinsamen Planer fuer alle Geraete - dann hielt der
 *    haengende Backofen Wasch- und Spuelmaschine mit auf. Verschiedene Geraete sind verschiedene
 *    Module mit eigener IP und duerfen parallel gefragt werden.
 *  - Gefragt wird nur ein Geraet, das gespraechsbereit ist (Kontrollfrage) und in dem kein
 *    Programm laeuft - siehe scanErlaubt.
 *  - Jede Stoerung (Timeout, abgebrochene oder abgelehnte Verbindung) schickt das Geraet in eine
 *    Pause, die sich verdoppelt: 5, 10, 20, 30 Minuten.
 *  - Eine Absage (404, 500, 101) ist erst endgueltig, wenn sie im WACHEN Zustand mehrfach und
 *    mit Abstand bestaetigt wurde - siehe einordnen und endgueltig.
 */

/**
 * Abstand zweier Scan-Anfragen an DASSELBE Geraet (seit 13.11.2026 abends je Geraet; vorher
 * ueber alle Geraete zusammen).
 *
 * 25 Sekunden: fuenfmal so lang wie die fuenf Sekunden, unter denen die Module am 13.11.2026
 * noch einknickten, und lang genug, dass die normale Abfrage (alle zwei Minuten /State) und
 * jeder Steuerbefehl dazwischen reichlich Platz haben.
 */
const TAKT_MS = 25000;

/**
 * Wie lange eine positive Antwort als Beleg fuer "das Modul ist wach" gilt.
 *
 * Ein 500 zaehlt nur als Absage, wenn das Modul kurz vorher bewiesen hat, dass es unterscheidet
 * (404 oder Daten). Sonst koennte es ein schlafendes Modul gewesen sein, das auf ALLES mit 500
 * antwortet.
 */
const WACH_GUELTIG_MS = 5 * 60000;

/** So oft muss eine Absage im wachen Zustand bestaetigt sein, bevor sie endgueltig gilt. */
const BESTAETIGUNGEN = 2;

/**
 * Mindestabstand zweier Bestaetigungen derselben Adresse.
 *
 * Sechs Stunden, damit die zweite Frage in einem anderen Geraetezustand faellt als die erste -
 * 2/1585 hat gezeigt, dass ein Leaf nicht immer antwortet, auch wenn das Modul wach ist.
 */
const BESTAETIGUNG_ABSTAND_MS = 6 * 3600000;

/**
 * Eine Adresse ohne gueltige Bestaetigung (etwa ein 500 ohne Wachbeleg) kommt fruehestens nach
 * dieser Zeit wieder dran - sonst fragte der Planer sie im Takt immer wieder.
 */
const WIEDERHOLUNG_MS = 30 * 60000;

/** Rueckzug nach Stoerungen: 5, 10, 20, dann 30 Minuten. */
const RUECKZUG_MIN_MS = 5 * 60000;
const RUECKZUG_MAX_MS = 30 * 60000;

/** Ein Geraet, das nur "gerade nicht" sagt (503, Kontrollfrage 500), wird so lange in Ruhe gelassen. */
const RUHE_MS = 10 * 60000;

/**
 * Pause nach einer Stoerung, verdoppelt sich je Stoerung in Folge.
 *
 * @param {number} fehlerInFolge  wie viele Stoerungen nacheinander (1 = die erste)
 * @returns {number} Pause in Millisekunden
 */
function rueckzugMs(fehlerInFolge) {
    const n = Math.max(1, fehlerInFolge || 1);
    return Math.min(RUECKZUG_MIN_MS * Math.pow(2, n - 1), RUECKZUG_MAX_MS);
}

/**
 * Wird der Stoerungszaehler wieder auf null gesetzt?
 *
 * Erst wenn die Schonphase nach der letzten Stoerung ohne neue Stoerung abgelaufen ist - nicht
 * schon bei der ersten guten Antwort. Am 13.11.2026 hing das DOP2 des Backofens H2469BP rund alle
 * zehn Minuten fuer mehrere Minuten, /State antwortete weiter. Weil eine einzige gute Antwort den
 * Zaehler loeschte, pendelte der Rueckzug ewig zwischen 5 und 10 Minuten und erreichte nie 30.
 *
 * @param {number} schonBis Ende der Schonphase (ms), 0/undefined = keine
 * @param {number} jetzt Zeitstempel in ms
 * @returns {boolean} true, wenn der Zaehler verziehen wird
 */
function fehlerVerzeihen(schonBis, jetzt) {
    return !schonBis || jetzt >= schonBis;
}

/**
 * Darf an diesem Geraet gerade gescannt werden - und in welcher Art?
 *
 * 'ruhe': Status 1 (aus) oder 2 (an) seit mindestens 5 min, 7 (Programm zu Ende) seit mindestens
 * 2 min. Hier zaehlen alle Antworten, auch 500 (mit Wachbeleg).
 *
 * 'betrieb': Status 5 (Programm laeuft) seit mindestens 10 min. BEWUSST ERLAUBT, gemessen am
 * 13.11.2026: Im Aus beantworten die EK037-Module von Wasch- und Spuelmaschine schon die
 * Kontrollfrage mit 500 - sie schlafen. Wach sind sie praktisch nur im und kurz nach dem Programm,
 * und die Spuelmaschine steht nach dem Programmende nur rund neun Minuten auf 7 (Statusverlauf
 * 07.-13.11.). Ohne den Betrieb kaeme der Scan auf wenige Adressen am Tag. Im Betrieb gilt deshalb:
 * nur Treffer und 404 zaehlen, ein 500 nie (das Modul ist dann oft nur ausgelastet - 07.09.2026,
 * 102 x 500), und je Geraet hoechstens eine Anfrage pro BETRIEB_ABSTAND_MS. Die ersten zehn Minuten
 * bleiben frei, weil der Adapter beim Start den Geraetekontext liest.
 *
 * Alles andere (gewaehlt, Startvorwahl, Pause, Fehler, Abbruch, unbekannt, nicht erreichbar): nein.
 *
 * @param {object} lage {status, seitMs, verbunden}
 * @param lage.status Statuswert des Geraets
 * @param lage.seitMs wie lange dieser Status schon steht
 * @param lage.verbunden ob die normale Abfrage das Geraet erreicht
 * @returns {false|'ruhe'|'betrieb'} ob und wie gescannt werden darf
 */
function scanErlaubt({ status, seitMs, verbunden }) {
    if (verbunden === false) {
        return false;
    }
    const st = Number(status);
    const ruhig = Number(seitMs) || 0;
    if ((st === 1 || st === 2) && ruhig >= 5 * 60000) {
        return 'ruhe';
    }
    if (st === 7 && ruhig >= 2 * 60000) {
        return 'ruhe';
    }
    if (st === 5 && ruhig >= 10 * 60000) {
        return 'betrieb';
    }
    return false;
}

/** Im Betrieb (Status 5) hoechstens eine Scan-Anfrage je Geraet in diesem Abstand. */
const BETRIEB_ABSTAND_MS = 60000;

/**
 * Zeitlimit je Scan-Anfrage - kuerzer als im Regelbetrieb.
 *
 * Am 04.09.2026 gemessen: Mit den acht Sekunden des Regelbetriebs brauchte ein Durchgang
 * ueber 60 Adressen mehr als fuenf Minuten, der ganze Scan waere auf zwei Stunden
 * hinausgelaufen. Die allermeisten Adressen existieren nicht, und eine Adresse, die es
 * gibt, antwortet schnell - wer nach drei Sekunden nichts gehoert hat, hoert auch nach
 * acht nichts.
 */
const SCAN_TIMEOUT_MS = 3000;

/**
 * Alle Adressen der Bereiche, in der Reihenfolge des Scans.
 *
 * @param bereiche die zu durchsuchenden Adressbereiche
 */
function adressen(bereiche = BEREICHE) {
    const liste = [];
    for (const b of bereiche) {
        for (let a = b.von; a <= b.bis; a++) {
            liste.push({ unit: b.unit, attr: a });
        }
    }
    return liste;
}

/**
 * Der Schluessel eines Leafs im Ergebnis - "2/6195".
 *
 * @param unit DOP2-Unit
 * @param attr DOP2-Attribut
 */
function schluessel(unit, attr) {
    return `${unit}/${attr}`;
}

/**
 * Zeitlimit einer Anfrage im langsamen Scan - so lang wie im Regelbetrieb.
 *
 * Drei Sekunden reichten, solange nur nach Existenz gefragt wurde. Ein grosses Leaf (etwa eine
 * Programmliste in Unit 14) braucht laenger; wird es nach drei Sekunden abgebrochen, steht ein
 * halb gesendeter Datenstrom im Modul - genau dort knickten die EK037-Module am 13.11.2026 ein.
 * Bei einer Anfrage je 25 Sekunden kostet das laengere Warten nichts.
 */
const SCAN_TIMEOUT_LANGSAM_MS = 8000;

/** Nach so vielen Stoerungen an DERSELBEN Adresse wird sie nicht mehr gefragt. */
const STOERUNGEN_JE_ADRESSE = 3;

/**
 * Wie oft ist eine Absage bestaetigt?
 *
 * Eintraege aus der Zeit vor dem langsamen Scan tragen keine Zaehlung. Ein altes 404 zaehlt als
 * eine Bestaetigung - ein 404 kann nur ein Modul sagen, das unterscheidet. Ein altes 500 zaehlt
 * nichts: Es kann aus einer Schlafphase stammen (2/1585, 13.11.2026).
 *
 * @param {object} e Eintrag aus dem Scan-Ergebnis
 * @returns {number} Zahl der Bestaetigungen
 */
function bestaetigungen(e) {
    if (!e || e.antwortet) {
        return 0;
    }
    if (typeof e.bestaetigt === 'number') {
        return e.bestaetigt;
    }
    const st = Number(e.status);
    return st === 404 || st === 101 ? 1 : 0;
}

/**
 * Ist diese Adresse erledigt?
 *
 * @param {object} e Eintrag aus dem Scan-Ergebnis
 * @returns {boolean} true bei Treffer, bestaetigter Absage oder einer Adresse, die wiederholt stoert
 */
function endgueltig(e) {
    if (!e) {
        return false;
    }
    if (e.antwortet) {
        return true;
    }
    if ((e.stoerungen || 0) >= STOERUNGEN_JE_ADRESSE) {
        return true;
    }
    return bestaetigungen(e) >= BESTAETIGUNGEN;
}

/**
 * Die naechste Adresse fuer den langsamen Scan.
 *
 * Reihenfolge: zuerst Adressen ohne gueltige Bestaetigung - nie gefragt oder ungeklaert - in der
 * Reihenfolge der BEREICHE, dann Absagen mit wenigen Bestaetigungen. Jeweils nur, wenn die letzte
 * Frage lange genug her ist (BESTAETIGUNG_ABSTAND_MS nach einer gueltigen Bestaetigung,
 * WIEDERHOLUNG_MS sonst).
 *
 * @param {object} bisher Scan-Ergebnis
 * @param {number} jetzt Zeitstempel in ms
 * @param bereiche die zu durchsuchenden Adressbereiche
 * @returns {{unit:number, attr:number}|null} naechste Adresse oder null, wenn gerade keine dran ist
 */
function naechsteAdresse(bisher, jetzt, bereiche = BEREICHE) {
    const erg = bisher || {};
    let beste = null;
    let besteRang = Infinity;
    for (const a of adressen(bereiche)) {
        const e = erg[schluessel(a.unit, a.attr)];
        if (!e) {
            // Nie gefragt: Rang 0 - und nichts kann davor liegen ausser einer frueheren Adresse
            // mit demselben Rang, die oben schon zurueckgegeben worden waere.
            return a;
        }
        if (endgueltig(e)) {
            continue;
        }
        const n = bestaetigungen(e);
        const zuletzt = Number(e.zuletzt) || 0;
        const abstand = n > 0 && e.wach !== false ? BESTAETIGUNG_ABSTAND_MS : WIEDERHOLUNG_MS;
        if (jetzt - zuletzt < abstand) {
            continue;
        }
        if (n === 0) {
            // Ungeklaert (etwa ein altes 500 aus einer Schlafphase): gleicher Rang wie "nie
            // gefragt" - die Reihenfolge der BEREICHE entscheidet, Unit 14 bleibt hinten.
            return a;
        }
        if (n < besteRang) {
            beste = a;
            besteRang = n;
        }
    }
    return beste;
}

/**
 * Ein Ergebnis des langsamen Scans einordnen.
 *
 * @param {object} bisher Scan-Ergebnis
 * @param {number} unit DOP2-Unit
 * @param {number} attr DOP2-Attribut
 * @param {object} ergebnis {felder} | {status, fehler, roh} | {status}
 * @param {object} umstand {wach, jetzt}
 * @param umstand.wach ob das Modul kurz vorher bewiesen hat, dass es unterscheidet
 * @param umstand.jetzt Zeitstempel in ms
 * @param umstand.besetztJeAdresse 503 gilt als Eigenschaft der Adresse (wach, im Ruhezustand)
 * @returns {object} neues Scan-Ergebnis (Kopie)
 */
function einordnen(bisher, unit, attr, ergebnis, { wach, jetzt, besetztJeAdresse = false }) {
    const erg = Object.assign({}, bisher);
    const k = schluessel(unit, attr);
    const alt = erg[k];
    if (beschaeftigt(ergebnis) && !besetztJeAdresse) {
        return erg; // "gerade nicht" sagt nichts ueber die Adresse
    }
    if (beschaeftigt(ergebnis)) {
        /*
         * 503 von einem nachweislich wachen Modul im Ruhezustand: Das liegt an der ADRESSE.
         * Gesehen am 13.11.2026 am Backofen H2469BP: 14/1566-1569 sauber 404, 14/1570
         * (Programmliste) 503. Ohne diese Regel bliebe der Scan an der Adresse haengen. Gezaehlt
         * wie eine Stoerung: nach STOERUNGEN_JE_ADRESSE Mal in Ruhe gelassen.
         */
        const e = Object.assign({ antwortet: false, status: null }, alt || {});
        e.stoerungen = (e.stoerungen || 0) + 1;
        e.zuletzt = jetzt;
        e.letzteStoerung = '503';
        erg[k] = e;
        return erg;
    }
    if (beantwortet(ergebnis) && ((ergebnis.felder && Object.keys(ergebnis.felder).length) || ergebnis.fehler)) {
        const neu = aufnehmen({}, unit, attr, ergebnis)[k];
        neu.zuletzt = jetzt;
        if (alt && !alt.antwortet) {
            // Fuer die Auswertung: Was stand hier vorher? (2/1585 stand auf 404/500.)
            neu.vorher = alt.status;
        }
        erg[k] = neu;
        return erg;
    }
    if (ueberlastet(ergebnis)) {
        // Keine Auskunft ueber die Adresse - nur mitzaehlen, damit eine Adresse, die jedes Mal
        // stoert, irgendwann in Ruhe gelassen wird.
        const e = Object.assign({ antwortet: false, status: null }, alt || {});
        e.stoerungen = (e.stoerungen || 0) + 1;
        e.zuletzt = jetzt;
        e.letzteStoerung = String(ergebnis.status).slice(0, 60);
        erg[k] = e;
        return erg;
    }
    if (!beantwortet(ergebnis)) {
        return erg;
    }
    // Eine Absage mit Status. 404/101 beweisen fuer sich, dass das Modul unterscheidet.
    const st = Number(ergebnis.status);
    const gueltig = wach || st === 404 || st === 101;
    const vorher = alt && !alt.antwortet ? alt : null;
    let n = vorher ? bestaetigungen(vorher) : 0;
    if (vorher && Number(vorher.status) !== st) {
        n = 0; // anderer Status als zuvor - von vorn zaehlen
    }
    if (!gueltig) {
        // Ohne Wachbeleg ist ein 500 keine Auskunft: bisherigen Stand behalten, nur den Zeitpunkt
        // merken - sonst loeschte ein ausgelastetes Modul eine gueltige 404-Bestaetigung.
        erg[k] = Object.assign({ antwortet: false, status: st }, vorher || {}, { zuletzt: jetzt, wach: false });
        return erg;
    }
    const e = { antwortet: false, status: st, bestaetigt: n + 1, zuletzt: jetzt, wach: true };
    if (vorher && vorher.stoerungen) {
        e.stoerungen = vorher.stoerungen;
    }
    erg[k] = e;
    return erg;
}

/**
 * Ein Ergebnis aufnehmen (ohne Bestaetigungszaehlung) - Grundform, die einordnen fuer Treffer nutzt.
 *
 * @param {object} bisher bisheriges Ergebnis
 * @param {number} unit DOP2-Unit
 * @param {number} attr DOP2-Attribut
 * @param {object} was  {status, felder} bei Erfolg, {status} bei Absage
 */
function aufnehmen(bisher, unit, attr, was) {
    const erg = Object.assign({}, bisher);
    const k = schluessel(unit, attr);
    if (was && was.felder && Object.keys(was.felder).length) {
        /*
         * Die Werte werden mitgeschrieben, nicht nur die Feldzahl.
         *
         * Ein Leaf, das antwortet, sagt fuer sich noch nichts - erst der Vergleich zweier
         * Zeitpunkte zeigt, welches Feld sich mit dem Programm bewegt. Ohne die Werte
         * muesste man jedes gefundene Leaf noch einmal von Hand ansehen.
         */
        erg[k] = { antwortet: true, felder: was.felder, anzahl: Object.keys(was.felder).length };
    } else if (was && was.fehler && Number(was.status) === 200) {
        /*
         * Geantwortet, aber nicht dekodierbar - trotzdem "antwortet".
         *
         * Bis 0.5.2 blieb eine solche Adresse offen (siehe beantwortet): 2/1585 der WWG760 kam
         * mit DOP2-Typ 33 zurueck, den der Parser nicht kannte, und der Scan wurde nie fertig.
         * Der Fehlertext steht getrennt vom Status, die Rohdaten (Hex) daneben - damit laesst
         * sich spaeter nachdekodieren, ohne das Geraet erneut zu fragen.
         */
        erg[k] = { antwortet: true, status: 200, fehler: String(was.fehler).slice(0, 200), felder: {}, anzahl: 0 };
        if (was.roh) {
            erg[k].roh = was.roh;
        }
    } else {
        erg[k] = { antwortet: false, status: (was && was.status) || null };
    }
    return erg;
}

/**
 * Sieht dieses Ergebnis nach einem ueberlasteten Modul aus?
 *
 * Eine saubere Absage ("es gibt diese Adresse nicht") kommt als HTTP-Status - beim
 * Miele-Modul meist 101. Ein abgebrochener Socket oder eine Zeitueberschreitung ist etwas
 * anderes: Da hat das Modul nicht geantwortet, weil es nicht konnte.
 *
 * @param ergebnis Ergebnis einer Abfrage
 */
function ueberlastet(ergebnis) {
    const st = ergebnis && ergebnis.status;
    // 503 heisst "gerade nicht" - das Geraet ist beschaeftigt, nicht die Adresse leer.
    if (st === 503 || st === '503') {
        return true;
    }
    return typeof st === 'string' && /hang up|Timeout|ECONNRESET|ECONNREFUSED|EPIPE|socket|Parse Error/i.test(st);
}

/**
 * Ist das Geraet nur BESCHAEFTIGT - oder wirklich am Ende?
 *
 * DER UNTERSCHIED ENTSCHEIDET, OB DER SCAN JE FERTIG WIRD. Beides galt bisher gleich viel:
 * Fuenf davon in Folge, und der Durchgang brach ab. Waehrend die Waschmaschine laeuft, kommt
 * aber fast jede Antwort als 503 - der Scan kam am 05.09.2026 in vier Wochen ueber 23 von
 * 882 Adressen nicht hinaus.
 *
 * Ein 503 ist eine HOEFLICHE ABSAGE: Das Modul hat die Frage gehoert und antwortet, es sei
 * gerade beschaeftigt. Darauf gehoert Geduld, kein Rueckzug - man wartet laenger und fragt
 * erneut.
 *
 * Ein abgebrochener Socket oder eine Zeitueberschreitung ist etwas anderes: Da hat das Modul
 * nicht geantwortet, WEIL ES NICHT KONNTE. Genau daran kuendigte sich am 04.09.2026 der
 * Ausfall an, bei dem es lokal und zur Cloud die Verbindung verlor. Dabei bleibt es beim
 * Abbruch.
 *
 * @param ergebnis Ergebnis einer Abfrage
 */
function beschaeftigt(ergebnis) {
    const st = ergebnis && ergebnis.status;
    return st === 503 || st === '503';
}

/**
 * War das eine ANTWORT auf die Frage - oder nur ein "gerade nicht"?
 *
 * DAS IST DER UNTERSCHIED, AN DEM DER ZWEITE SCANLAUF GESCHEITERT IST. Am 04.09.2026 lief
 * er, waehrend die Maschine wusch: Von 239 unbeantworteten Adressen kamen 132 mit HTTP 503
 * zurueck, dazu 46 abgebrochene Verbindungen. Der Code hat all das als "geprueft"
 * abgelegt - und damit Adressen abgehakt, die nie wirklich gefragt wurden. Zwei Leafs, die
 * im ersten Lauf noch Daten geliefert hatten (2/122 und 2/123), standen danach als
 * erledigt im Ergebnis und waeren nie wieder an die Reihe gekommen.
 *
 * Eine Absage ist nur dann eine Absage, wenn das Geraet sie ausgesprochen hat: 101 ("gibt
 * es nicht"), 404, 500. Alles andere bleibt offen.
 *
 * @param ergebnis Ergebnis einer Abfrage
 */
function beantwortet(ergebnis) {
    if (ergebnis && ergebnis.felder && Object.keys(ergebnis.felder).length) {
        return true;
    }
    // Geantwortet, nur nicht dekodierbar - siehe aufnehmen.
    if (ergebnis && ergebnis.fehler && Number(ergebnis.status) === 200) {
        return true;
    }
    const st = ergebnis && ergebnis.status;
    if (st == null) {
        return false;
    }
    if (ueberlastet(ergebnis)) {
        return false;
    }
    return typeof st === 'number' || /^\d+$/.test(String(st));
}

/**
 * Wie weit ist der Scan?
 *
 * "erledigt" heisst endgueltig (Treffer, bestaetigte Absage, Dauerstoerer). "nieGefragt" sind
 * Adressen ohne jeden Eintrag; "zuBestaetigen" sind gefragte, aber noch nicht bestaetigte.
 *
 * @param bisher bisheriges Ergebnis
 * @param bereiche die zu durchsuchenden Adressbereiche
 */
function fortschritt(bisher, bereiche = BEREICHE) {
    const liste = adressen(bereiche);
    const erg = bisher || {};
    let erledigt = 0;
    let nieGefragt = 0;
    for (const a of liste) {
        const e = erg[schluessel(a.unit, a.attr)];
        if (!e) {
            nieGefragt++;
        } else if (endgueltig(e)) {
            erledigt++;
        }
    }
    const alle = liste.length;
    const gefunden = Object.values(erg).filter(x => x && x.antwortet).length;
    const offen = alle - erledigt;
    const zuBestaetigen = offen - nieGefragt;
    return {
        alle,
        fertig: erledigt,
        offen,
        nieGefragt,
        zuBestaetigen,
        gefunden,
        text: `${erledigt} of ${alle} addresses settled, ${gefunden} answering${
            offen ? ` - ${offen} open (${nieGefragt} never asked, ${zuBestaetigen} to confirm)` : ' - done'
        }`,
    };
}

/**
 * Nur die Leafs, die geantwortet haben - nach Feldzahl sortiert.
 *
 * @param bisher bisheriges Ergebnis
 */
function treffer(bisher) {
    return Object.entries(bisher || {})
        .filter(([, v]) => v.antwortet)
        .map(([k, v]) => ({ leaf: k, felder: v.anzahl }))
        .sort((a, b) => b.felder - a.felder);
}

/**
 * Was hat sich seit dem letzten Scan bewegt?
 *
 * DAS IST DER EIGENTLICHE ZWECK. Ein Leaf mit vierzig Feldern ist nur dann interessant,
 * wenn sich darin etwas aendert, waehrend die Maschine laeuft. Zwei Scans - einer im
 * Leerlauf, einer waehrend eines Programms - und die Felder, die dazwischen anders sind,
 * sind die Kandidaten. Alles andere ist Konfiguration und Geraetebeschreibung.
 *
 * @param vorher Ergebnis des vorigen Scans
 * @param nachher Ergebnis des aktuellen Scans
 */
function unterschiede(vorher, nachher) {
    const raus = [];
    for (const [leaf, neu] of Object.entries(nachher || {})) {
        const alt = (vorher || {})[leaf];
        if (!alt || !alt.antwortet || !neu.antwortet) {
            continue;
        }
        for (const [idx, wert] of Object.entries(neu.felder || {})) {
            const vorWert = (alt.felder || {})[idx];
            if (vorWert === undefined) {
                continue;
            }
            if (JSON.stringify(vorWert) !== JSON.stringify(wert)) {
                raus.push({ leaf, feld: idx, von: vorWert, bis: wert });
            }
        }
    }
    return raus;
}

/**
 * Soll die Suche anspringen, weil ein Geraet eingeschaltet wurde?
 *
 * Ein Geraet, das die meiste Zeit aus ist, wird sonst nie durchsucht - der Scan braucht ein
 * waches Modul, und wer soll den Schalter genau dann umlegen? Beim Backofen ist das der
 * Regelfall.
 *
 * Die Automatik greift nur beim Uebergang aus dem Aus-Zustand und nur bei einem Geraet, dessen
 * Suche noch nie gelaufen ist. Damit kann sie keine Entscheidung ueberstimmen: Wer den Schalter
 * bewusst ausmacht, hat dann schon Adressen im Ergebnis.
 *
 * @param {object} lage  {an, vorher, nachher, schalter, geprueft}
 * @param lage.an ob die automatische Suche eingeschaltet ist
 * @param lage.vorher vorheriger Statuswert des Geraets (1 = aus)
 * @param lage.nachher neuer Statuswert des Geraets
 * @param lage.schalter ob die Suche gerade laeuft (Schalter an)
 * @param lage.geprueft ob die Suche fuer das Geraet schon einmal gelaufen ist
 * @returns {boolean} true, wenn die Suche jetzt starten soll
 */
function beimEinschaltenStarten({ an, vorher, nachher, schalter, geprueft }) {
    if (!an) {
        return false;
    }
    if (Number(nachher) === 1) {
        return false;
    } // wird gerade ausgeschaltet
    if (vorher != null && Number(vorher) !== 1) {
        return false;
    } // war schon an
    if (schalter === true) {
        return false;
    } // laeuft bereits
    return !geprueft; // schon einmal gelaufen: Finger weg
}

/**
 * Darf trotz stummer Kontrollfrage gescannt werden?
 *
 * Die Kontrollfrage setzt voraus, dass das Geraet den Adressbereich der Kontrolladresse kennt -
 * sonst antwortet es mit 500 statt mit 404, und das ist von "gerade beschaeftigt" nicht zu
 * unterscheiden. Ein solches Geraet wuerde nie gescannt.
 *
 * Deshalb: Hat es die Kontrollfrage noch NIE beantwortet, wird nach `grenze` Anlaeufen trotzdem
 * ein Durchgang gewagt. Sobald sie einmal geantwortet hat, gilt sie fuer dieses Geraet.
 *
 * @param {object} lage  {kennt, taub, grenze}
 * @param lage.kennt ob die Kontrollfrage frueher schon beantwortet wurde
 * @param lage.taub wie oft sie zuletzt unbeantwortet blieb
 * @param lage.grenze erlaubte Zahl unbeantworteter Kontrollfragen
 * @returns {boolean} true, wenn trotzdem gescannt werden darf
 */
function trotzdemVersuchen({ kennt, taub, grenze }) {
    if (kennt) {
        return false;
    }
    return (taub || 0) >= grenze;
}

/**
 * Leafs, die ein einzelnes Geraet oder das Heimnetz kennzeichnen - im Export maskiert.
 *
 * 2/145 Seriennummer, 14/1565 vermutlich EUI/MAC des Moduls, 14/1566 Modulnummer (XkmIdent),
 * 14/1571 MAC (XkmIdentLabel), 14/1573 IP-Adressen und WLAN-Name (XkmConfigIp/SSID). Ihre Feldnummern und Typen bleiben sichtbar -
 * fuer die Auswertung zaehlt, DASS ein Leaf antwortet und wie es aufgebaut ist, nicht der Inhalt.
 */
const KENNUNGS_LEAFS = new Set(['2/145', '14/1565', '14/1566', '14/1571', '14/1573']);

/** Platzhalter fuer maskierte Werte. */
const MASKE = '***';

/**
 * Einen Wert maskieren, Aufbau erhalten: Zahlen und Texte werden zu "***", Listen behalten ihre
 * Laenge, Wahrheitswerte bleiben (sie verraten nichts).
 *
 * @param v beliebiger Wert aus dem Scan
 * @returns {unknown} maskierter Wert
 */
function maskieren(v) {
    if (Array.isArray(v)) {
        return v.map(maskieren);
    }
    if (v && typeof v === 'object') {
        return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, maskieren(x)]));
    }
    if (typeof v === 'boolean' || v == null) {
        return v;
    }
    return MASKE;
}

/**
 * Texte und Zahlen ausserhalb der Kennungs-Leafs, die eine bekannte Kennung ENTHALTEN, maskieren
 * (etwa die Seriennummer in einem Programm- oder Dateinamen). Sonst unveraendert.
 *
 * @param v beliebiger Wert
 * @param {string[]} kennungen Seriennummern o. Ae.
 * @returns {unknown} Wert, Treffer maskiert
 */
function kennungenErsetzen(v, kennungen) {
    if (Array.isArray(v)) {
        return v.map(x => kennungenErsetzen(x, kennungen));
    }
    if (v && typeof v === 'object') {
        return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, kennungenErsetzen(x, kennungen)]));
    }
    if (typeof v === 'string' || typeof v === 'number') {
        const t = String(v);
        // MAC-Adresse in beliebiger Schreibweise, mit oder ohne Trennzeichen
        if (/\b[0-9a-f]{2}([:-]?[0-9a-f]{2}){5}\b/i.test(t) && /[a-f:-]/i.test(t)) {
            return MASKE;
        }
        for (const k of kennungen) {
            if (k && t.includes(String(k))) {
                return MASKE;
            }
        }
    }
    return v;
}

/**
 * Das Scan-Ergebnis ohne Kennungen - zum Teilen in Foren und Fehlerberichten.
 *
 * @param {object} bisher Scan-Ergebnis {"2/145": {antwortet, felder, ...}, ...}
 * @param {string[]} [kennungen] zusaetzlich zu maskierende Texte, etwa die Seriennummer
 * @returns {object} Kopie, Kennungen maskiert
 */
function anonymisieren(bisher, kennungen = []) {
    const aus = {};
    for (const [leaf, v] of Object.entries(bisher || {})) {
        if (!v || typeof v !== 'object') {
            aus[leaf] = v;
            continue;
        }
        const kopie = Object.assign({}, v);
        if (KENNUNGS_LEAFS.has(leaf)) {
            if (kopie.felder) {
                kopie.felder = maskieren(kopie.felder);
            }
            if (kopie.roh) {
                kopie.roh = MASKE;
            }
        } else {
            if (kopie.felder) {
                kopie.felder = kennungenErsetzen(kopie.felder, kennungen);
            }
            // Rohbytes lassen sich nicht feldweise pruefen: Steht eine Kennung als Text darin,
            // faellt das ganze Feld weg.
            if (kopie.roh && kennungen.some(k => k && kopie.roh.includes(Buffer.from(String(k)).toString('hex')))) {
                kopie.roh = MASKE;
            }
        }
        aus[leaf] = kopie;
    }
    return aus;
}

module.exports = {
    KENNUNGS_LEAFS,
    anonymisieren,
    BEREICHE,
    PAUSE_MS,
    SCAN_TIMEOUT_MS,
    SCAN_TIMEOUT_LANGSAM_MS,
    TAKT_MS,
    WACH_GUELTIG_MS,
    BESTAETIGUNGEN,
    BESTAETIGUNG_ABSTAND_MS,
    WIEDERHOLUNG_MS,
    RUHE_MS,
    STOERUNGEN_JE_ADRESSE,
    rueckzugMs,
    fehlerVerzeihen,
    scanErlaubt,
    BETRIEB_ABSTAND_MS,
    bestaetigungen,
    endgueltig,
    naechsteAdresse,
    einordnen,
    ueberlastet,
    beantwortet,
    beschaeftigt,
    adressen,
    schluessel,
    aufnehmen,
    fortschritt,
    treffer,
    unterschiede,
    beimEinschaltenStarten,
    trotzdemVersuchen,
};
