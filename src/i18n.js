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

const fmt = (lang, n, digits = 4, min = 0) => Number(n).toLocaleString(lang === 'pt' ? 'pt-PT' : 'en', { minimumFractionDigits: min, maximumFractionDigits: Math.max(digits, min) });

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
    'assume.promo': ({ label, until }) => `includes the promotion "${label}" (until ${until})`,
    'assume.napPrice': ({ vat }) => `operator's price from the NAP, taken as the whole €/kWh price; the NAP publishes prices without VAT, so this region's VAT (${vat} %) is added`,
    'assume.napWrong': ({ why }) => `the NAP's price for this charger is left out, it's known to be wrong: ${why}`,
    'assume.napVatIn': () => "operator's price from the NAP, taken as the whole €/kWh price; this operator publishes it with VAT included (checked in its app), so no VAT is added",
    'assume.napTimeOfUse': () => "this operator's price changes with the time of day, but on the NAP it publishes only one fixed value, the highest of the day: this estimate is the most the session can cost (congestion fees aside). At other hours it can cost much less. There is no public source with the price at each hour; only the operator's own app shows it",
    'option.opcDirect.peak': () => 'the highest price of the day at this charger; lower at other hours (see the operator\'s app)',

    'option.adhoc': () => 'Bank card / QR at the charger (no CEME)',
    'option.adhoc.note': ({ vat }) => `MOBI.E's ad hoc price, published without VAT; ${vat} % VAT added`,
    'option.opcDirect': ({ operator }) => `${operator} direct (their app/card, no subscription)`,
    'option.opcDirect.noName': () => 'Operator direct (their app/card, no subscription; the NAP names no operator)',
    'option.opcDirect.walkUp': ({ operator }) => `Bank card / QR at the charger${operator ? ` (${operator})` : ''}, no app or account`,
    'option.opcDirect.appOrCard': ({ operator }) => `${operator || 'Operator'} direct: their app, or a bank card at the charger's terminal, no subscription`,
    'option.opcDirect.note': ({ price, vat }) => `this charger's price on the NAP, ${price} €/kWh excl. VAT (${vat} % VAT added)`,
    'option.opcDirect.noteVatIn': ({ price }) => `this charger's price on the NAP, ${price} €/kWh, VAT included`,
    'option.direct.note': ({ source, checked }) => `price outside the CEME system, final with VAT; can vary a few cents by site; source ${source}, checked ${checked}`,
    'option.walkUp': () => 'Card terminal (TPA) or QR at the charger, no account needed.',
    'option.fee': ({ eur, per }) => `+ ${fmt('en', eur, 2)} €/${per === 'year' ? 'year' : 'month'} subscription`,
    'option.feeUnknown': () => '+ subscription fee',
    'option.sessionFee': ({ eur }) => `Includes ${fmt('en', eur, 2, 2)} € per session (connection fee).`,
    'option.stale': () => '(checked a while ago: may be out of date)',
    'option.islandVat': () => '(listed with mainland VAT; island VAT is lower, so check the price on the app or at the charger)',

    // CEME promotions at one charging network (src/promos.js).
    'promo.label': ({ ceme, network, amount }) => `${ceme} at ${network}: ${amount}`,
    'promo.energy': ({ eur }) => `−${eur} €/kWh on energy`,
    'promo.opc': ({ pct }) => `−${pct}% on the operator fee`,
    'promo.final': ({ eur }) => `${eur} €/kWh all in (operator fee and VAT included)`,
    'promo.free': ({ kwh }) => `first ${kwh} kWh of each month free`,
    'promo.labelAny': ({ ceme, amount }) => `${ceme}: ${amount}`,
    'promo.note.final': () => 'it replaces the usual energy + operator fee, even where that would be lower',
    'promo.note.freeLeft': ({ left, free }) => `${left} of this month's ${free} free kWh left, used first in this session; assumed to cover energy and network access only (tax, activation fee and operator fee still paid)`,
    'promo.note.freeUnknown': ({ free }) => `priced as if none of this month's ${free} free kWh were used yet: pass month_kwh (kWh already charged this month with this tariff) to apply it; assumed to cover energy and network access only`,
    'promo.note.new': ({ until, hours }) => `new customers only: sign up by ${until}${hours ? `, then the discount lasts ${hours} h` : ''}. Not in any total`,
    'promo.note.all': ({ until, tariff }) => `for every ${tariff} customer at this network, until ${until}`,
    'promo.note.allAny': ({ until, tariff }) => `for every ${tariff} customer at any MOBI.E charger, until ${until}`,

    'note.outside': () => 'Outside MOBI.E: pay the operator directly, no CEME.',
    'note.noUserTariff': () => "None of the user's tariffs apply at this socket.",
    'note.noTariff': () => 'No CEME tariff applies to this socket.',
    'note.noCeme': () => "CEME energy prices are unavailable right now (the pricing service didn't answer), so this socket has no CEME total; the other ways to pay are listed. Say so, and suggest trying again in a few minutes for the CEME price.",
    'note.truncated': ({ n, total }) => `Only the ${n} nearest of the ${total} sites found were priced, to keep the answer fast; narrow the search (radius_km, corridor_km, filters) to see the rest.`,
    'note.detailTop': ({ n }) => `The timeline (detail) is only included for the first ${n} results; for one charger's breakdown, use estimate_charging_cost.`,
    'err.tariffs': () => "The CEME tariff list can't be fetched right now (the pricing service didn't answer). Try again in a few minutes.",
    'err.placeWhich': ({ place, towns }) => `"${place}" fits several towns: ${towns}. Ask the user which one (or pass lat/lon) and call again with its full name.`,
    'assume.sites': ({ n }) => `prices from ${n} NAP sites at the same spot, priced together; check the address of the socket you pick`,
    'err.pricing': () => "Energy prices can't be fetched right now (the CEME pricing service didn't answer), and nothing else is known to price here. Try again in a few minutes.",

    'plan.charge': () => '€/charge',
    'plan.after': ({ min }) => `after ${min} min`,
    'plan.until': ({ min }) => `until ${min} min`,
    'plan.or': () => 'or',
    'plan.exVat': () => '(excl. VAT)',
    'plan.withVat': () => '(VAT included)',
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
    'assume.voltage': () => 'Voltage is what each operator declares on the NAP for the socket, not measured; some DC sockets declare a placeholder (750 or 600 V) instead of the real value. Sockets with no declared voltage are left out.',
    'note.noVoltage': () => 'The charger data loaded now has no socket voltages yet, so min_voltage was ignored: these results are not filtered by voltage.',
    'err.whereOrFilter': () => 'Give lat+lon, place or route, or, to search the whole country, at least one filter (query, min_kw, min_voltage, connectors, dc_only).',
    'note.nationwide': ({ shown, total }) => `No place given, so all of Portugal (or the region asked) was searched: ${total} sites match, most powerful first; showing ${shown}. For a full list, narrow with region or query, or raise limit.`,
    'note.operators': () => 'Operators as the NAP publishes them (every public charger in Portugal, on MOBI.E and outside it), grouped by NAP operatorId. Not the DGEG registry: an operator registered with the DGEG but with no charger on the NAP is not here.',
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
    'assume.promo': ({ label, until }) => `inclui a promoção "${label}" (até ${until})`,
    'assume.napPrice': ({ vat }) => `preço do operador vindo do PAN, assumido como o preço total por kWh; o PAN publica os preços sem IVA, por isso somamos o IVA desta região (${vat} %)`,
    'assume.napWrong': ({ why }) => `o preço do PAN para este posto fica de fora, sabe-se que está errado: ${why}`,
    'assume.napVatIn': () => 'preço do operador vindo do PAN, assumido como o preço total por kWh; este operador publica-o com IVA incluído (confirmado na app dele), por isso não somamos IVA',
    'assume.napTimeOfUse': () => 'o preço deste operador muda com a hora do dia, mas no PAN ele publica um só valor fixo, o mais alto do dia: esta estimativa é o máximo que o carregamento pode custar (sem contar taxas de ocupação). Noutras horas pode custar bastante menos. Não há nenhuma fonte pública com o preço de cada hora; só a app do operador o mostra',
    'option.opcDirect.peak': () => 'preço mais alto do dia neste posto; mais baixo noutras horas (ver a app do operador)',

    'option.adhoc': () => 'Cartão bancário / QR no posto (sem CEME)',
    'option.adhoc.note': ({ vat }) => `preço ad hoc da MOBI.E, publicado sem IVA; somamos ${vat} % de IVA`,
    'option.opcDirect': ({ operator }) => `${operator} directo (app/cartão do operador, sem subscrição)`,
    'option.opcDirect.noName': () => 'Operador directo (app/cartão do operador, sem subscrição; o PAN não diz qual é)',
    'option.opcDirect.walkUp': ({ operator }) => `Cartão bancário / QR no posto${operator ? ` (${operator})` : ''}, sem app nem conta`,
    'option.opcDirect.appOrCard': ({ operator }) => `${operator || 'Operador'} directo: app do operador ou cartão bancário no terminal do posto, sem subscrição`,
    'option.opcDirect.note': ({ price, vat }) => `preço deste posto no PAN, ${price} €/kWh sem IVA (somamos ${vat} % de IVA)`,
    'option.opcDirect.noteVatIn': ({ price }) => `preço deste posto no PAN, ${price} €/kWh, com IVA incluído`,
    'option.direct.note': ({ source, checked }) => `preço fora do sistema CEME, final com IVA; pode variar uns cêntimos por posto; fonte ${source}, verificado em ${checked}`,
    'option.walkUp': () => 'Terminal de pagamento (TPA) ou QR no posto, sem conta.',
    'option.fee': ({ eur, per }) => `+ ${fmt('pt', eur, 2)} €/${per === 'year' ? 'ano' : 'mês'} de subscrição`,
    'option.feeUnknown': () => '+ mensalidade',
    'option.sessionFee': ({ eur }) => `Inclui ${fmt('pt', eur, 2, 2)} € por sessão (taxa de ligação).`,
    'option.stale': () => '(verificado há algum tempo: pode estar desactualizado)',
    'option.islandVat': () => '(preço com IVA do continente; nas ilhas o IVA é mais baixo, confirme o preço na app ou no posto)',

    'promo.label': ({ ceme, network, amount }) => `${ceme} nos postos ${network}: ${amount}`,
    'promo.energy': ({ eur }) => `−${eur} €/kWh na energia`,
    'promo.opc': ({ pct }) => `−${pct}% na tarifa do operador`,
    'promo.final': ({ eur }) => `${eur} €/kWh tudo incluído (tarifa do operador e IVA incluídos)`,
    'promo.free': ({ kwh }) => `primeiros ${kwh} kWh de cada mês grátis`,
    'promo.labelAny': ({ ceme, amount }) => `${ceme}: ${amount}`,
    'promo.note.final': () => 'substitui a soma habitual de energia + tarifa do operador, mesmo onde esta seria mais baixa',
    'promo.note.freeLeft': ({ left, free }) => `restam ${left} dos ${free} kWh grátis deste mês, usados primeiro neste carregamento; assumimos que cobrem só a energia e o acesso às redes (imposto, activação e tarifa do operador pagam-se na mesma)`,
    'promo.note.freeUnknown': ({ free }) => `cotado como se ainda não tivesse gasto nenhum dos ${free} kWh grátis deste mês: passa month_kwh (kWh já carregados este mês com este tarifário) para o aplicar; assumimos que cobrem só a energia e o acesso às redes`,
    'promo.note.new': ({ until, hours }) => `só para clientes novos: adesão até ${until}${hours ? `, e o desconto dura ${hours} h` : ''}. Não entra em nenhum total`,
    'promo.note.all': ({ until, tariff }) => `para todos os clientes ${tariff} nesta rede, até ${until}`,
    'promo.note.allAny': ({ until, tariff }) => `para todos os clientes ${tariff} em qualquer posto MOBI.E, até ${until}`,

    'note.outside': () => 'Fora da MOBI.E: paga-se directamente ao operador, sem CEME.',
    'note.noUserTariff': () => 'Nenhum dos tarifários do utilizador se aplica a esta tomada.',
    'note.noTariff': () => 'Nenhum tarifário CEME se aplica a esta tomada.',
    'note.noCeme': () => 'Os preços de energia dos CEME não estão disponíveis neste momento (o serviço de preços não respondeu), por isso esta tomada não tem total CEME; estão as outras formas de pagar. Diz isso ao utilizador e sugere tentar daqui a uns minutos para o preço CEME.',
    'note.truncated': ({ n, total }) => `Só foram cotados os ${n} locais mais próximos dos ${total} encontrados, para a resposta ser rápida; restringe a pesquisa (radius_km, corridor_km, filtros) para ver os restantes.`,
    'note.detailTop': ({ n }) => `A timeline (detail) só vem nos primeiros ${n} resultados; para o detalhe de um posto, usa estimate_charging_cost.`,
    'err.tariffs': () => 'Não é possível obter a lista de tarifários CEME neste momento (o serviço de preços não respondeu). Tenta daqui a alguns minutos.',
    'err.placeWhich': ({ place, towns }) => `"${place}" serve a várias localidades: ${towns}. Pergunta ao utilizador qual é (ou usa lat/lon) e volta a chamar com o nome completo.`,
    'assume.sites': ({ n }) => `preços de ${n} locais do PAN no mesmo sítio, cotados juntos; confirma a morada da tomada que escolheres`,
    'err.pricing': () => 'Não é possível obter os preços de energia neste momento (o serviço de preços CEME não respondeu), e não há outro preço conhecido aqui. Tenta daqui a alguns minutos.',

    'plan.charge': () => '€/carregamento',
    'plan.after': ({ min }) => `após ${min} min`,
    'plan.until': ({ min }) => `até ${min} min`,
    'plan.or': () => 'ou',
    'plan.exVat': () => '(sem IVA)',
    'plan.withVat': () => '(com IVA)',
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
    'assume.voltage': () => 'A tensão é a que cada operador declara no PAN para a tomada, não é medida; algumas tomadas DC declaram um valor de reserva (750 ou 600 V) em vez do real. As tomadas sem tensão declarada ficam de fora.',
    'note.noVoltage': () => 'Os dados de postos carregados agora ainda não têm a tensão das tomadas, por isso o min_voltage foi ignorado: estes resultados não estão filtrados por tensão.',
    'err.whereOrFilter': () => 'Indica lat+lon, place ou route, ou, para pesquisar o país todo, pelo menos um filtro (query, min_kw, min_voltage, connectors, dc_only).',
    'note.nationwide': ({ shown, total }) => `Sem sítio indicado, pesquisou-se Portugal todo (ou a região pedida): ${total} locais servem, os mais potentes primeiro; a mostrar ${shown}. Para a lista completa, restringe com region ou query, ou aumenta o limit.`,
    'note.operators': () => 'Operadores tal como o PAN os publica (todos os postos públicos em Portugal, na MOBI.E e fora dela), agrupados pelo operatorId do PAN. Não é o registo da DGEG: um operador registado na DGEG sem postos no PAN não aparece.',
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
  t.num = (n, digits, min) => fmt(t.lang, n, digits, min);
  return t;
}
