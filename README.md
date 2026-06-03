# Where Would HMS Belfast Hit Right Now?

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
| Gun           | BL 6"/50 Mk XXIII — 112 lb shell, ~841 m/s, 23.3 km max range |

## Run it

```bash
npm install
npm run dev      # http://localhost:5173
npm run build    # static bundle in dist/
```

Static site: vanilla JS, [Vite](https://vitejs.dev/),
[Leaflet](https://leafletjs.com/). Ballistics run client-side in WebAssembly via
[js-ballistics](https://github.com/o-murphy/js-ballistics).

## Optional: AI impact descriptions

By default the headline names the impact via reverse geocoding. A small Node
proxy can also render the impact zone as a map image and have a Claude vision
model describe it (*"Mill Hill Golf Course, somewhere round the 10th."*).

```bash
ANTHROPIC_API_KEY=sk-ant-... npm run proxy   # :8787
npm run dev                                  # Vite forwards /api/* to it
```

If the proxy is down or has no key, the app falls back to the geocoded line.

See [TODO.md](TODO.md) for open questions and remaining work.

## Credits

- Gun & range tables: [NavWeaps](http://www.navweaps.com/Weapons/WNBR_6-50_mk23.php)
- Ballistics engine: [js-ballistics](https://github.com/o-murphy/js-ballistics)
- Weather, tide & elevations: [Open-Meteo](https://open-meteo.com/),
  [Environment Agency](https://environment.data.gov.uk/flood-monitoring/doc/reference)
- Maps & place names: [OpenStreetMap](https://www.openstreetmap.org/copyright)

Educational toy. Uses many approximations, not a real fire-control solution.
