# 00 — Glossary

Start here if EV charging in Portugal is new to you. The other docs and most
code comments use these words without explaining them again.

## The network

**MOBI.E** — Portugal's public charging network, and the company that runs
its central platform. Most public chargers in Portugal are on it. The idea:
any driver with any card can charge at any MOBI.E charger, and MOBI.E sorts
out who pays whom behind the scenes.

**CEME** — *Comercializador de Eletricidade para a Mobilidade Elétrica*. The
company whose card or app you charge with (EDP, Galp, Via Verde, Prio...). It
sells you the **energy**. Each CEME has one or more **tariffs** (prices). You
can have cards from several CEMEs and pick one per session.

**OPC** — *Operador de Ponto de Carregamento*, the charger's owner/operator
(IONITY, Galp, EDP, Atlante, Powerdot...). It charges a **usage fee** for the
charger itself, on top of the CEME's energy. Each OPC sets its own fee, per
charger.

**On MOBI.E, one session = two bills folded into one invoice**: the CEME's
energy + the OPC's usage fee. That's the whole reason this project exists:
nobody shows you both together.

**DPC** — *Detentor de Ponto de Carregamento*, the holder of a
**private-access** charger connected to MOBI.E: a home wallbox, a condominium
garage, a company car park for its staff or fleet. It is not an operator: no
OPC, no OPC fee, so a session there costs only the CEME energy, EGME and taxes,
and only the users its owner authorizes can charge. DPC chargers aren't in the
NAP, so ohmigo never lists them. AI assistants confuse DPC with OPC easily;
`INSTRUCTIONS` in `src/mcp.js` spells out the difference for them.

**eMSP** — *e-Mobility Service Provider*, the international name for what
Portugal calls a CEME.

## Ways to pay at a charger

**CEME card/app** — the normal MOBI.E way: energy from your CEME + OPC fee.

**Ad hoc** — pay at the charger with a bank card or a QR code, no CEME
account. MOBI.E publishes this price per socket (`AD_HOC_PAYMENT` in its
tariff file).

**Direct offers** — paying outside the CEME system: a walk-up card terminal
(**TPA**) or QR code, the operator's own app or subscription (IONITY Power,
Atlante GO), or a roaming app (Electroverse, Elli). No open data publishes
these prices; we scrape them weekly from a public price list and correct them
by hand ([04](04-operator-offers.md)).

**TPA** — *Terminal de Pagamento Automático*, the card terminal on the charger.

**Outside MOBI.E** — some chargers aren't on MOBI.E at all (Tesla
Superchargers, Continente). You pay the operator directly, and no CEME card
works there.

## The bill, piece by piece

**Energy price** — what your CEME charges per kWh. Can be fixed, or
**indexed** to the wholesale market price (OMIE), changing every 15 minutes.

**TAR** — *Tarifa de Acesso às Redes*, the grid access fee set by the energy
regulator (ERSE). It's inside the CEME's energy price.

**IEC** — a special tax on electricity, per kWh.

**EGME / activation fee** — a fixed fee per session that goes to MOBI.E's
platform manager.

**VAT (IVA)** — 23 % on the mainland, less in Madeira and the Azores. Applies
to the whole invoice, OPC fee included.

**Vazio / fora de vazio** — off-peak / peak hours. "Bi-horário" tariffs have
two prices; the hours depend on the region and the tariff's cycle.

**OMIE** — the Iberian electricity market. Its price changes every 15 minutes
and drives indexed tariffs.

Everything above except the OPC fee (energy, TAR, IEC, EGME, VAT on the
energy) is computed by **ceme-v2**, a sibling project. ohmigo asks it and
never recomputes it.

## Data sources

**NAP / PAN** — *National Access Point* (*Ponto de Acesso Nacional* in
Portuguese). The government's open data portal where Portugal's public
chargers are published, MOBI.E's and those outside it (Tesla, Continente...),
in a European XML format called **DATEX II**. Two feeds:
- *static*: every site and charger, plugs, power, address, payment methods (once a week is plenty);
- *dynamic*: the live status of every charger plus the OPC fees (republished every few minutes).

**MOBI.E tariff file** — a CSV with every socket's official OPC fee, including
per-minute tiers ("0.18 €/min after 30 min") and the ad hoc price.

**nap-dashboard** — a sibling project that downloads and cleans the NAP and
MOBI.E files every week. It builds the dataset ohmigo loads
([05](05-dataset.md)).

**operator_id** — the NAP's short code for an operator (IONY = IONITY, HORZ =
Powerdot, ATLA = Atlante). More reliable than the name: Atlante appears under
seven spellings, all with the same id.

## Charging

**kW vs kWh** — kW is power (speed), kWh is energy (amount). A 50 kW charger
running for one hour delivers 50 kWh.

**SoC** — *state of charge*, the battery % on the car's dashboard.

**AC / DC** — AC chargers (3.7-22 kW) send alternating current to the car's
*on-board charger*, which converts it, so the car limits the speed. DC
chargers (50-400 kW) feed the battery directly, and slow down as it fills,
especially above 80 %.

**Charging curve** — the power a car accepts at each SoC; every model has its
own. **10-80 % time** — how long a car takes on a fast enough DC charger to go
from 10 to 80 %. Most spec sites publish it.

**Charging losses** — energy that turns into heat between the charger's meter
and the battery. You pay for it anyway.

**Voltage level (BT / MT)** — chargers connect to the grid at low (BT, BTN,
BTE) or medium (MT) voltage. The TAR differs, so each CEME tariff exists in a
BT and an MT version.

## The AI side

**MCP** — *Model Context Protocol*. A standard way for AI assistants (ChatGPT,
Claude, Gemini, coding agents) to call tools on a server. The server describes
its tools as JSON Schema; the assistant decides when to call them.

**MCP Apps** — an MCP extension that lets a tool come with a small web page
the chat app shows inline. Our results view (`ui/results.html`) is one.

**Tool / structuredContent** — a tool is a function the assistant can call;
`structuredContent` is the JSON we return for it to read.
