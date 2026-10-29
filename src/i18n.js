// Every sentence the server sends to a person, in English and Portuguese.
//
// Who talks to the user is the AI assistant (ChatGPT, Claude...), not us: it
// reads our JSON and writes the answer in the user's language. But some of
// our text reaches the user almost word for word: the "assumptions" list, the
// labels of each way to pay, the progress message while we fetch live data,
// and the inline results view. Those come in the language the assistant asks
// for with the `lang` argument (the instructions tell it to always pass the
// user's language).
//
// We only write two languages. Any other language gets English, and the
// assistant translates it on the way out, which it does well.
//
// To add a sentence: add the key to BOTH tables. test/i18n.test.js fails if a
// key is missing from one of them.

const fmt = (lang, n, digits = 4) => Number(n).toLocaleString(lang === 'pt' ? 'pt-PT' : 'en', { maximumFractionDigits: digits });

export const MESSAGES = {
  en: {
    // The NAP (National Access Point) is where Portugal's public chargers,
    // MOBI.E's and those outside it, publish their live status. In
    // Portuguese it's the PAN.
    'progress.live': () => 'Getting live charger status from the NAP…',

    'assume.window': ({ from, to }) => `Energy priced quarter-hour by quarter-hour for a session from ${from} to ${to} (local time): off-peak hours and OMIE changes during the session count`,
    'assume.startOnly': ({ from }) => `Energy priced as if the whole session happened at ${from} (local time); a session crossing into off-peak hours may cost less`,
    'assume.losses': ({ pct, kind }) => `${pct}% charging losses (${kind}), billed at the charger's meter`,
    'assume.carLimitUnknown': ({ kind, kw }) => `car's max ${kind} power unknown, assumed ${kw} kW`,
    'assume.chargerKwUnknown': () => 'charger power not published, assumed the car limit',
    'assume.curve': ({ kw }) => `duration from the car's charging curve, capped at the charger's ${kw} kW`,
    'assume.dc1080': ({ below, mins, capped, above }) => `DC average ${below} kW up to 80% (from the car's ${mins} min 10-80% time${capped ? ', capped by the charger' : ''}), ${above} kW above`,
    'assume.dcGeneric': ({ shareBelow, peak, shareAbove }) => `DC average ${shareBelow}% of ${peak} kW up to 80%, ${shareAbove}% above (generic curve)`,
    'assume.levelUnknown': () => 'socket voltage level unknown, priced as low voltage (BT)',
    'assume.noFee': () => 'operator fee not published (MOBI.E file or NAP); total excludes it',
    'assume.napFee': () => 'operator fee from the NAP live feed: rounded to the cent, no time tiers',
    'assume.feeRange': () => 'two values published for one fee component; showing the range',
    'assume.perMinute': () => 'per-minute fee counted until the target %, unplugging right away',

    'option.adhoc': () => 'Bank card / QR at the charger (no CEME)',
    'option.adhoc.note': () => "MOBI.E's ad-hoc price; assumed to include VAT (consumer price), which MOBI.E does not state",
    'option.opcDirect': ({ operator }) => `${operator} direct (their app/card)`,
    'option.opcDirect.note': ({ price }) => `* assumes the NAP's ${price} is a final €/kWh price incl. VAT; the NAP doesn't say what it covers`,
    'option.direct.note': ({ source, checked }) => `price outside the CEME system, final with VAT; can vary a few cents by site; source ${source}, checked ${checked}`,
    'option.walkUp': () => 'Card terminal (TPA) or QR at the charger, no account needed.',
    'option.fee': ({ eur, per }) => `+ ${fmt('en', eur, 2)} €/${per === 'year' ? 'year' : 'month'} subscription`,
    'option.feeUnknown': () => '+ subscription fee',
    'option.stale': () => '(checked a while ago: may be out of date)',
    'option.islandVat': () => '(listed with mainland VAT; island VAT is lower, so check the price on the app or at the charger)',

    'note.outside': () => 'Outside MOBI.E: pay the operator directly, no CEME.',
    'note.noUserTariff': () => "None of the user's tariffs apply at this socket.",
    'note.noTariff': () => 'No CEME tariff applies to this socket.',

    'plan.charge': () => '€/charge',
    'plan.after': ({ min }) => `after ${min} min`,
    'plan.until': ({ min }) => `until ${min} min`,
    'plan.or': () => 'or',
    'plan.exVat': () => '(excl. VAT)',
    'plan.free': () => 'free (no operator fee)',

    'err.where': () => 'Give lat+lon, place, or route.',
    'err.place': ({ place }) => `No chargers found in a place called "${place}". Pass lat/lon instead.`,
    'err.target': () => 'target_pct must be above start_pct.',
    'err.noMatch': () => 'No chargers match. Widen radius_km/corridor_km or relax the filters.',
    'err.noneLeft': () => 'No charger matches (time limit, availability or filters). Raise max_minutes, set available_only=false or widen the search.',
    'err.point': ({ id }) => `Unknown or ambiguous point_id ${id}. Pass the charger as site (its siteId, code or name) instead.`,
    'err.which': () => 'Say which charger: site (siteId, code or name from lookup_charger) or point_id.',
    'err.lookup': ({ query }) => `No charger matches "${query}". Try fewer words (operator or brand + town), the code on the charger's sticker, or lat/lon.`,
    'err.several': ({ query, n }) => `"${query}" fits chargers in ${n} places. Ask the user which one and pass its siteId as site ("+N": more sites at that same spot, priced together). The best matches:`,
    'err.direction': ({ query }) => `"${query}" is a motorway service area with chargers on both sides of the road, and the driver can only reach the side they're driving on. Ask the user which way they're going (where they're heading) and call again with towards. The sides (direction they say they serve, if any):`,
    'several.sides': () => '(both sides of a motorway: ask the direction too)',
    'note.direction': () => "Some of these are the two sides of a motorway service area (otherSide); the driver can only use the one on their side. Unless the user said where they're heading, ask, then call again with towards.",
    'assume.side': ({ to }) => `side of the motorway picked for driving towards ${to}: the service area on the right-hand side; the data doesn't say which way each side serves, so check the signs`,
    'assume.sideLabel': ({ label, to }) => `the ${label} side of the service area, for driving towards ${to}`,
    'assume.bothSides': ({ to }) => `both sides of the motorway service area are listed: the data can't tell which one serves driving towards ${to}; the signs will`,
    'credit.osm': () => '"osm" data © OpenStreetMap contributors (ODbL), openstreetmap.org/copyright',
    'note.partial': ({ words }) => `No charger matches every word; the best ones lack: ${words}. Don't present them as the charger the user meant without saying so.`,
  },
  pt: {
    'progress.live': () => 'A obter o estado dos postos em tempo real no PAN…',

    'assume.window': ({ from, to }) => `Energia cotada quarto de hora a quarto de hora, para um carregamento das ${from} às ${to} (hora local): contam as horas de vazio e as mudanças do OMIE durante o carregamento`,
    'assume.startOnly': ({ from }) => `Energia cotada como se o carregamento todo fosse às ${from} (hora local); um carregamento que entre no vazio pode sair mais barato`,
    'assume.losses': ({ pct, kind }) => `${pct}% de perdas no carregamento (${kind}), medidas no contador do posto`,
    'assume.carLimitUnknown': ({ kind, kw }) => `potência máxima ${kind} do carro desconhecida, assumidos ${kw} kW`,
    'assume.chargerKwUnknown': () => 'potência do posto não publicada, assumido o limite do carro',
    'assume.curve': ({ kw }) => `duração pela curva de carregamento do carro, limitada aos ${kw} kW do posto`,
    'assume.dc1080': ({ below, mins, capped, above }) => `média DC de ${below} kW até 80% (pelos ${mins} min de 10-80% do carro${capped ? ', limitada pelo posto' : ''}), ${above} kW acima`,
    'assume.dcGeneric': ({ shareBelow, peak, shareAbove }) => `média DC de ${shareBelow}% de ${peak} kW até 80%, ${shareAbove}% acima (curva genérica)`,
    'assume.levelUnknown': () => 'nível de tensão da tomada desconhecido, cotado como baixa tensão (BT)',
    'assume.noFee': () => 'tarifa do operador não publicada (ficheiro MOBI.E ou PAN); o total não a inclui',
    'assume.napFee': () => 'tarifa do operador vinda do PAN em tempo real: arredondada ao cêntimo, sem escalões por tempo',
    'assume.feeRange': () => 'dois valores publicados para a mesma componente; mostramos o intervalo',
    'assume.perMinute': () => 'tarifa por minuto contada até à % pretendida, desligando logo a seguir',

    'option.adhoc': () => 'Cartão bancário / QR no posto (sem CEME)',
    'option.adhoc.note': () => 'preço ad hoc da MOBI.E; assumimos que inclui IVA (preço ao consumidor), o que a MOBI.E não diz',
    'option.opcDirect': ({ operator }) => `${operator} directo (app/cartão do operador)`,
    'option.opcDirect.note': ({ price }) => `* assume que o ${price} do PAN é um preço final em €/kWh com IVA; o PAN não diz o que inclui`,
    'option.direct.note': ({ source, checked }) => `preço fora do sistema CEME, final com IVA; pode variar uns cêntimos por posto; fonte ${source}, verificado em ${checked}`,
    'option.walkUp': () => 'Terminal de pagamento (TPA) ou QR no posto, sem conta.',
    'option.fee': ({ eur, per }) => `+ ${fmt('pt', eur, 2)} €/${per === 'year' ? 'ano' : 'mês'} de subscrição`,
    'option.feeUnknown': () => '+ mensalidade',
    'option.stale': () => '(verificado há algum tempo: pode estar desactualizado)',
    'option.islandVat': () => '(preço com IVA do continente; nas ilhas o IVA é mais baixo, confirme o preço na app ou no posto)',

    'note.outside': () => 'Fora da MOBI.E: paga-se directamente ao operador, sem CEME.',
    'note.noUserTariff': () => 'Nenhum dos tarifários do utilizador se aplica a esta tomada.',
    'note.noTariff': () => 'Nenhum tarifário CEME se aplica a esta tomada.',

    'plan.charge': () => '€/carregamento',
    'plan.after': ({ min }) => `após ${min} min`,
    'plan.until': ({ min }) => `até ${min} min`,
    'plan.or': () => 'ou',
    'plan.exVat': () => '(sem IVA)',
    'plan.free': () => 'grátis (sem tarifa do operador)',

    'err.where': () => 'Indica lat+lon, place ou route.',
    'err.place': ({ place }) => `Não há postos num sítio chamado "${place}". Usa lat/lon.`,
    'err.target': () => 'target_pct tem de ser maior que start_pct.',
    'err.noMatch': () => 'Nenhum posto corresponde. Alarga radius_km/corridor_km ou alivia os filtros.',
    'err.noneLeft': () => 'Nenhum posto serve (limite de tempo, disponibilidade ou filtros). Sobe max_minutes, põe available_only=false ou alarga a pesquisa.',
    'err.point': ({ id }) => `point_id ${id} desconhecido ou ambíguo. Passa antes o posto em site (o siteId, o código ou o nome).`,
    'err.which': () => 'Diz qual é o posto: site (siteId, código ou nome do lookup_charger) ou point_id.',
    'err.lookup': ({ query }) => `Nenhum posto corresponde a "${query}". Tenta menos palavras (operador ou marca + localidade), o código no autocolante do posto, ou lat/lon.`,
    'err.several': ({ query, n }) => `"${query}" serve a postos em ${n} sítios. Pergunta ao utilizador qual é e passa o siteId dele em site ("+N": mais locais nesse mesmo sítio, cotados juntos). Os que mais se aproximam:`,
    'err.direction': ({ query }) => `"${query}" é uma área de serviço de auto-estrada com postos dos dois lados da via, e o condutor só chega ao lado em que circula. Pergunta ao utilizador para onde vai (o sentido) e volta a chamar com towards. Os lados (sentido que indicam, se indicam):`,
    'several.sides': () => '(os dois lados de uma auto-estrada: pergunta também o sentido)',
    'note.direction': () => 'Alguns são os dois lados de uma área de serviço de auto-estrada (otherSide); o condutor só usa o do seu lado. Se o utilizador não disse para onde vai, pergunta, e volta a chamar com towards.',
    'assume.side': ({ to }) => `lado da auto-estrada escolhido para quem vai para ${to}: a área de serviço do lado direito; os dados não dizem que sentido serve cada lado, confirme nas placas`,
    'assume.sideLabel': ({ label, to }) => `o lado ${label} da área de serviço, para quem vai para ${to}`,
    'assume.bothSides': ({ to }) => `estão os dois lados da área de serviço: os dados não dizem qual serve quem vai para ${to}; as placas dizem`,
    'credit.osm': () => 'Dados "osm" © contribuidores do OpenStreetMap (ODbL), openstreetmap.org/copyright',
    'note.partial': ({ words }) => `Nenhum posto tem todas as palavras; aos melhores falta: ${words}. Não os apresentes como o posto que o utilizador queria sem o dizer.`,
  },
};

// "pt-PT", "pt-BR", "pt" -> "pt"; anything else -> "en".
export const pickLang = (...hints) => {
  for (const h of hints) if (typeof h === 'string' && h) return h.toLowerCase().startsWith('pt') ? 'pt' : 'en';
  return 'en';
};

// t('pt')('assume.losses', { pct: 7, kind: 'DC' }) -> the sentence.
export function translator(lang) {
  const table = MESSAGES[lang] || MESSAGES.en;
  const t = (key, params = {}) => (table[key] || MESSAGES.en[key])(params);
  t.lang = table === MESSAGES.pt ? 'pt' : 'en';
  t.num = (n, digits) => fmt(t.lang, n, digits);
  return t;
}
