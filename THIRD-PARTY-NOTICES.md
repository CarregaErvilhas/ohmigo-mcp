# Third-party data

| Data | Source | Terms | How we credit it |
|---|---|---|---|
| Charger sites, plugs, live status, OPC fees | NAP / PAN (IMT), via [nap-dashboard](https://github.com/CarregaErvilhas/nap-dashboard) | Open data | `dataAsOf` and the view's footer |
| Socket power, voltage and current, names, opening hours, contacts (the `osm` fields) | [OpenStreetMap](https://www.openstreetmap.org/copyright), via nap-dashboard | © OpenStreetMap contributors, [ODbL 1.0](https://opendatacommons.org/licenses/odbl/1-0/): share-alike, so data derived from it stays ODbL | `credit` on every result that uses it; the agent is told to credit OpenStreetMap |
| OPC fees and ad hoc prices | MOBI.E tariff file, via nap-dashboard | Open data | as above |
| CEME energy prices | [ceme-v2](https://ceme.ocarroeletrico.com/api) | Our own service | — |
| Walk-up, app, roaming and subscription prices (`offers/custofinal.json`) | [Preços (finais) kWh Portugal](https://custofinal.blogspot.com), by Alexandre Moleiro | **Alexandre Moleiro's**; used with his permission, with attribution | Blog and author named in every direct option's `note` and in the view's footer; the agent is told to cite both |
| Corrections (`offers/manual.json`) | Each entry's `source` URL | Public price pages | Named in the option's `note` |

None of this data is covered by the project's license ([LICENSE](LICENSE),
AGPL-3.0-only): each source keeps its own terms. `offers/custofinal.json` may
not be reused outside ohmigo without Alexandre Moleiro's own permission.
