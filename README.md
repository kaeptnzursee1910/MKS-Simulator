# MKS-Simulator

Browser-App zum **Zeichnen, Herleiten und Simulieren ebener Mehrkörpersysteme** – am PC und auf dem Handy, ohne Installation und ohne Server.

1. **Modell zeichnen** – Strukturelemente skizzenhaft platzieren und verbinden:
   Klotz, Scheibe, Stufenrolle, Stab, Punktmasse, Boden, Festpunkt/Wand, Festlager, Loslager (Gleitlager), Gelenk,
   Rollen ohne Gleiten, Gleiten (Führung), Seil, Feder, Dämpfer, Feder ∥ Dämpfer, Drehfeder, Drehdämpfer, Kraft F(t), Moment M(t).
   Stäbe werden über Anfangs- und Endpunkt gezeichnet (auch schräg), Kreisbahnen (Mulde/Kuppe) führen rollende oder gleitende
   Scheiben und Punktmassen. Seile/Federn dürfen freie Enden haben; Lager werden immer selbst gesetzt.
   Über masselose Knoten verbundene Elemente (Reihenschaltung) werden zu Ersatzelementen zusammengefasst (1/k = 1/k₁ + 1/k₂).
2. **Freiheitsgrade & Methode festlegen** – Lagrange 1. Art, Lagrange 2. Art oder d'Alembert-Lagrange,
   jeweils **linearisiert** (kleine Auslenkungen) oder **nichtlinear**. Freiheitsgrade (x, y, φ je Körper, mit positiver Richtung)
   werden in der Oberfläche gewählt, der Freiheitsgrad f wird automatisch geprüft.
3. **Bewegungsgleichungen** – symbolische Herleitung mit Zwischenschritten (Kinematik, T, U, D, generalisierte Kräfte,
   Jacobi-Matrizen bzw. Zwangskräfte λ) und Matrizenform; als LaTeX kopierbar.
4. **Simulation** – Anfangswerte, Zeitdiskretisierung (explizites Euler, symplektisches Euler, Heun, Runge-Kutta 4), Schrittweite;
   Animation der Zeichnung und Zeitverläufe (q, q̇, λ, Energie), CSV-Export.

## Starten

Die App ist rein statisch. Lokal z. B.:

```bash
python3 -m http.server 8000
# dann http://localhost:8000 öffnen
```

Über **GitHub Pages** (Settings → Pages → Branch `main`, Ordner `/`) ist sie direkt im Browser und auf dem Handy nutzbar.

## Aufbau

| Pfad | Inhalt |
|---|---|
| `js/cas/` | eigenes kleines Computeralgebrasystem: Ausdrücke, Vereinfachung, Ableitung, Taylorreihen, LaTeX, Parser |
| `js/mech/elements.js` | Strukturelemente, Anschlusspunkte, exakte Winkelfunktionen |
| `js/mech/model.js` | Körperkoordinaten, Bindungsgleichungen, Federlängen, Lasten |
| `js/mech/kinematics.js` | Freiheitsgradanalyse, Auflösen der Bindungen (exakt bzw. bis 2. Ordnung) |
| `js/mech/derive.js` | Lagrange 1. Art, Lagrange 2. Art, d'Alembert-Lagrange |
| `js/mech/numeric.js` | Übersetzung in JS-Funktionen, Integrationsverfahren, DAE-Lösung mit Projektion |
| `js/ui/` | Zeichnung (SVG), Bedienung (Maus/Touch), Panels, Diagramme |
| `vendor/katex` | KaTeX 0.16.9 (MIT) für die Formeldarstellung |
| `test/` | Tests: `node test/cas.test.mjs`, `node test/derive.test.mjs all`, `node test/validate.test.mjs` (Vergleich mit Lehrbuchlösungen) |

## Modellannahmen

- Ebene Bewegung; Koordinaten sind Auslenkungen aus der **gezeichneten Lage** (x nach rechts, y nach oben, ϑ gegen den Uhrzeigersinn).
- Federn sind in der gezeichneten Lage entspannt (Länge l₀); Seile sind dehnstarr und straff.
- Liegt ein Seil-/Federende tangential an einer Scheibe, gilt es als aufgewickelt (Abwickellänge R·ϑ).
- Linearisiert: Kinematik der abhängigen Koordinaten bis zur 2. Ordnung, Energien bis zur 2. Ordnung (z. B. Pendel-Rückstellung durch Gewicht);
  bei Lagrange 1. Art wird die geometrische Steifigkeit aus den statischen Zwangskräften λ₀ berücksichtigt.
- Nichtlinear mit Lagrange 2. Art / d'Alembert müssen sich die Bindungen nach den abhängigen Koordinaten auflösen lassen;
  sonst hilft Lagrange 1. Art oder der linearisierte Modus.
