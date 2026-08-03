# Where Would HMS Belfast Hit Right Now?

[![CI](https://github.com/SilentKinfolk/where-would-hms-belfast-hit/actions/workflows/ci.yml/badge.svg)](https://github.com/SilentKinfolk/where-would-hms-belfast-hit/actions/workflows/ci.yml)
[![Deploy](https://github.com/SilentKinfolk/where-would-hms-belfast-hit/actions/workflows/deploy.yml/badge.svg)](https://github.com/SilentKinfolk/where-would-hms-belfast-hit/actions/workflows/deploy.yml)

**Live site:** <https://wherewouldhmsbelfasthit.com>

A ballistic calculator for the 6-inch guns of
[HMS Belfast](https://en.wikipedia.org/wiki/HMS_Belfast), the WWII cruiser moored
in the Pool of London. The forward turrets have pointed at the **London Gateway
services** on the M1 since 1971. This app simulates where a shell fired from
that fixed laying would land in today's weather.

|  |  |
|---|---|
| Firing origin | HMS Belfast forward turrets — 51.50676°N, 0.08219°W |
| Target        | London Gateway services — 51.63107°N, 0.26473°W |
| Range/bearing | ~18.69 km on bearing ~318° |
| Gun           | BL 6"/50 Mk XXIII — 112 lb shell, 823 m/s service MV (841 new-gun), 23.3 km max range |

## Run it

```bash
npm install
npm run dev      # http://localhost:5173
npm run build    # static bundle in dist/
```

Static site: vanilla JS, [Vite](https://vitejs.dev/),
[Leaflet](https://leafletjs.com/). The exterior-ballistics engine,
[js-ballistics](https://github.com/o-murphy/js-ballistics) (C++ compiled to
WebAssembly), runs in the hourly cron rather than the browser. Visitors only fetch
the pre-computed `public/impacts.json`; see [How it works](#how-it-works) below.

## How it works

Nothing is computed in the visitor's browser. A GitHub Actions cron fires the
fixed gun laying through live weather every hour, runs the ballistics and
the Claude vision describer server-side, and bakes the result into
`public/impacts.json`. The page just fetches that file.

```mermaid
flowchart TD
    IN["Live inputs: weather, tide, elevation, ensemble<br/>Fixed inputs: gun laying, DEM tile"]
    CRON["GitHub Actions cron, hourly<br/>fire-the-guns.yml"]
    BAL["Ballistics, js-ballistics WASM<br/>impact point + CEP ellipse"]
    AI["Claude vision reads the rendered map<br/>writes the one-line description"]
    OUT[["public/impacts.json<br/>committed + pushed to main"]]
    WEB["Browser fetches + draws on Leaflet<br/>no compute, no API key"]

    IN --> CRON --> BAL --> AI --> OUT --> WEB

    classDef ai fill:#ffe3f1,stroke:#c2186a,stroke-width:2px,color:#111;
    class AI ai;
```

Pink = the Claude vision call. Expand for the full, stage-by-stage version:

<details>
<summary>Full pipeline — every stage</summary>

```mermaid
flowchart TD
    subgraph SRC["Live data, fetched every tick"]
        direction TB
        WX["Open-Meteo Forecast<br/>surface + winds-aloft profile<br/>+ soil temp as magazine proxy"]
        ENS["Open-Meteo Ensemble<br/>ICON-EPS member spread<br/>= forecast uncertainty"]
        ELV["Open-Meteo Elevation<br/>gun + target ground height"]
        TIDE["EA Tower Pier gauge<br/>live Thames tide level"]
    end

    subgraph FIXED["Fixed inputs, in the repo"]
        direction TB
        LAY["LAYING<br/>bearing 317.7, elevation 24.9<br/>solved once, never moves"]
        GUNC["GUN spec<br/>6-inch Mk XXIII<br/>drag curve + dispersion PEs"]
        DEMT["EA LIDAR DEM tile<br/>public/dem/london-gateway.bin"]
    end

    CRON(["GitHub Actions cron, hourly<br/>fire-the-guns.yml runs log-impact.mjs"])
    SRC --> CRON
    FIXED --> CRON

    subgraph COMPUTE["computeImpact - where the shell lands"]
        direction TB
        FIT["Fit one effective surface temp so the<br/>modelled air density matches the<br/>measured profile along the flight"]
        ENGINE["js-ballistics, point-mass WASM<br/>drag, wind layers, Coriolis, spin drift"]
        LOOP["Re-fire against the DEM until the<br/>ground-intersection height converges"]
        DISP["CEP + 50% ellipse: gun dispersion<br/>combined in quadrature with the<br/>forecast (met) uncertainty"]
        FIT --> ENGINE --> LOOP --> DISP
    end
    CRON --> FIT
    DEMT -.->|sampled in| LOOP

    DISP --> RESULT["ImpactResult<br/>impact lat/lon, track, miss,<br/>CEP, ellipse, conditions"]

    subgraph ENRICH["enrichImpact - the headline line"]
        direction TB
        NOM["Nominatim reverse geocode<br/>place-name prefix"]
        GATE{"Dot moved over 60 m,<br/>or place changed?"}
        RENDER["Render CEP map<br/>staticmaps + OSM tiles"]
        CLAUDE["Claude vision, Sonnet 4.6<br/>reads the map, writes the<br/>casual locator fragment"]
        REUSE["Reuse last tick's line<br/>no API call"]
        NOM --> GATE
        GATE -->|yes| RENDER --> CLAUDE
        GATE -->|no| REUSE
    end
    RESULT --> NOM
    CLAUDE --> LINE["description =<br/>place + fragment"]
    REUSE --> LINE

    RESULT --> OG["OG share image<br/>staticmaps then grayscale<br/>public/og.png"]

    LINE --> IMPACTS[["public/impacts.json<br/>{ latest, history }<br/>committed + pushed to main"]]
    RESULT --> IMPACTS
    OG --> IMPACTS

    subgraph BROWSER["Visitor's browser - no compute, no API key"]
        direction TB
        FETCH["loadShared pulls impacts.json from<br/>raw.githubusercontent.com<br/>every 5 min + on focus"]
        DRAW["Leaflet: ship, target, impact X,<br/>ellipse, track, ghost trail"]
        FETCH --> DRAW
    end
    IMPACTS --> FETCH

    classDef src fill:#eef2ff,stroke:#4f5bd5,color:#111;
    classDef ai fill:#ffe3f1,stroke:#c2186a,stroke-width:2px,color:#111;
    classDef out fill:#e7f7ec,stroke:#2e7d46,color:#111;
    class WX,ENS,ELV,TIDE,LAY,GUNC,DEMT src;
    class CLAUDE ai;
    class IMPACTS,OG out;
```

Blue = live data sources · pink = the Claude vision call · green = the published
artifacts the browser reads.

</details>

## AI impact descriptions

The headline line (*"Mill Hill Golf Course, somewhere around the 15th hole."*)
is written by a Claude vision model reading the rendered impact map. It runs
once per hourly cron tick on GitHub Actions and is baked into
`public/impacts.json`, so visitors never trigger an API call and the key
never reaches the browser.

For local prompt iteration the same call is wrapped in a small Node proxy:

```bash
ANTHROPIC_API_KEY=sk-ant-... npm run proxy   # :8787
npm run dev                                  # Vite forwards /api/* to it
```

## Research this could spawn

This models a single shell, not a salvo. The physics is real; the load-bearing
inputs aren't all measured. The gun laying, the range table, the shell's drag and
spin drift are estimates, not measurements.

The open list — what to gather, and the archives and people to ask — is in
**[TODO.md](TODO.md)**.

## Credits

- Gun & range tables: [NavWeaps](http://www.navweaps.com/Weapons/WNBR_6-50_mk23.php)
- Ballistics engine: [js-ballistics](https://github.com/o-murphy/js-ballistics)
- Weather, tide & elevations: [Open-Meteo](https://open-meteo.com/),
  [Environment Agency](https://environment.data.gov.uk/flood-monitoring/doc/reference)
- Maps & place names: [OpenStreetMap](https://www.openstreetmap.org/copyright)

Educational toy. Uses many approximations, not a real fire-control solution.
