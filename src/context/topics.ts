/**
 * Lightweight rule-based topic tagging for context items + retrieval queries.
 *
 * Aim is precision, not recall: a tag should only fire when its keywords match
 * unambiguously. Tags drive the trend-velocity ranker and the retrieval boost.
 */

export type Topic =
  | 'monsoon'
  | 'traffic'
  | 'pmc'
  | 'metro'
  | 'roads'
  | 'ai'
  | 'jobs'
  | 'startup'
  | 'economy'
  | 'tech'
  | 'maharashtra'
  | 'politics'
  | 'civic'
  | 'crime'
  | 'weather'
  | 'festival'
  | 'pune-area'
  | 'sports';

interface Rule {
  topic: Topic;
  patterns: RegExp[];
}

// JavaScript's \b only anchors on ASCII word characters, so it cannot reliably
// gate Devanagari matches. We drop \b on Marathi patterns and rely on the
// keywords themselves being specific enough.
const RULES: Rule[] = [
  { topic: 'monsoon', patterns: [
    /\b(rain|monsoon|flood(ing)?|waterlog\w*|downpour|cloudburst|drizzle|thunderstorm)\b/i,
    /(पाऊस|पावसा|पावसाळ|पूर|पाणी साचले|मुसळधार)/,
  ] },
  { topic: 'traffic', patterns: [
    /\b(traffic|congest\w*|jam|gridlock|signal|chowk|junction|diversion|peak hour)\b/i,
    /(वाहतूक|कोंडी|सिग्नल|चौक|जॅम|डायव्हर्शन)/,
  ] },
  { topic: 'pmc', patterns: [
    /\bPMC\b|\bP\.M\.C\.\b|\bPune Municipal Corporation\b|\bPCMC\b|\bMunicipal Corporation\b/i,
    /(पुणे महापालिका|महानगर पालिका|पुणे मनपा|मनपा)/,
  ] },
  { topic: 'metro', patterns: [
    /\b(metro|MahaMetro|Pune Metro|metro line|metro station|metro rail)\b/i,
    /(मेट्रो|पुणे मेट्रो)/,
  ] },
  { topic: 'roads', patterns: [
    /\b(pothole|road dug|road work|FC Road|JM Road|MG Road|Karve Road|Sinhagad Road|Solapur Road|Nagar Road|expressway|flyover|underpass)\b/i,
    /(खड्ड[ाेी]|रस्ता|उड्डाणपूल|एक्सप्रेसवे)/,
  ] },
  { topic: 'ai', patterns: [
    /\b(AI|artificial intelligence|gen(?:erative)? AI|LLM|large language model|machine learning|automation|agentic|copilot|chatbot)\b/i,
    /(कृत्रिम बुद्धिमत्ता|ऑटोमेशन|एआय)/,
  ] },
  { topic: 'jobs', patterns: [
    /\b(job|jobs|hiring|layoff|layoffs|campus placement|placement season|employment|workforce|career|salary|salaries|talent|upskill|reskill|future of work)\b/i,
    /(नोकरी|नोकऱ्या|रोजगार|भरती|कर्मचारी|कौशल्य)/,
  ] },
  { topic: 'startup', patterns: [
    /\b(startup|startups|founder|founders|funding|fundraise|seed round|Series [A-Z]|VC|venture capital|SaaS|unicorn|soonicorn|GCCs?)\b/i,
    /(स्टार्टअप|उद्योजक|गुंतवणूक|भांडवल)/,
  ] },
  { topic: 'economy', patterns: [
    /\b(economy|economic|macro|GDP|inflation|repo rate|RBI|exports?|manufacturing|services PMI|capex|fiscal|monetary policy|markets?|consumption|demand|productivity)\b/i,
    /(अर्थव्यवस्था|महागाई|उत्पादन|निर्यात|बाजार|रिझर्व्ह बँक)/,
  ] },
  { topic: 'tech', patterns: [
    /\b(tech|technology|software|developer|developers|IT services|cloud|data centre|data center|semiconductor|deeptech|SaaS|cybersecurity|fintech)\b/i,
    /(तंत्रज्ञान|सॉफ्टवेअर|डेव्हलपर|आयटी)/,
  ] },
  { topic: 'maharashtra', patterns: [
    /\b(Maharashtra|Mumbai|Navi Mumbai|Pimpri|Chinchwad|Chakan|Talegaon|MIDC|Nashik|Nagpur|Aurangabad|Sambhajinagar)\b/i,
    /(महाराष्ट्र|मुंबई|नाशिक|नागपूर|छत्रपती संभाजीनगर|पिंपरी|चिंचवड|चाकण)/,
  ] },
  { topic: 'politics', patterns: [
    /\b(BJP|Congress|NCP|Shiv ?Sena|MNS|Mahayuti|MVA|Mahavikas|Aghadi|election|MLA|MP|CM|Chief Minister|Fadnavis|Pawar|Thackeray)\b/i,
    /(भाजप|काँग्रेस|राष्ट्रवादी|शिवसेना|मनसे|महायुती|आघाडी|आमदार|खासदार|मुख्यमंत्री|फडणवीस|पवार|ठाकरे)/,
  ] },
  { topic: 'civic', patterns: [
    /\b(water (cut|supply)|power cut|garbage|drainage|sewage|encroachment|illegal construction|civic)\b/i,
    /(पाणी ?कपात|वीज ?कपात|कचरा|गटार|अतिक्रमण)/,
  ] },
  { topic: 'crime', patterns: [
    /\b(murder|assault|robbery|theft|fraud|cheating|FIR|arrest|police|cyber ?crime|abduction|missing)\b/i,
    /(खून|हल्ला|चोरी|फसवणूक|पोलीस|अटक|गुन्हा)/,
  ] },
  { topic: 'weather', patterns: [
    /\b(temperature|heat ?wave|cold ?wave|humidity|forecast|IMD|weather)\b/i,
    /(तापमान|उष्णता|थंडी|हवामान)/,
  ] },
  { topic: 'festival', patterns: [
    /\b(Ganesh|Ganpati|Diwali|Holi|Pola|Dussehra|Navratri|Eid|Christmas|Gudi ?Padwa|Sankranti)\b/i,
    /(गणेश|गणपती|दिवाळी|होळी|पोला|दसरा|नवरात्र|गुढी ?पाडवा|संक्रांत)/,
  ] },
  { topic: 'sports', patterns: [
    /\b(cricket|IPL|T20|ODI|test match|wicket|century|run chase|bowling|batting|BCCI|ICC|F1|formula 1|grand prix|football|premier league|transfer window|olympics|badminton|tennis grand slam|Wimbledon|US Open|Pro Kabaddi)\b/i,
    /(क्रिकेट|आयपीएल|सामना|धाव|गोल|फुटबॉल)/,
  ] },
  { topic: 'pune-area', patterns: [
    /\b(Pune|Kothrud|Aundh|Baner|Hinjewadi|Wakad|Viman ?Nagar|Kharadi|Hadapsar|Koregaon ?Park|Kalyani ?Nagar|Magarpatta|Camp|Deccan|Shivajinagar|Karve ?Nagar|Warje|Bibwewadi|Katraj|Sinhagad|Pashan|Bavdhan|Pimpri|Chinchwad)\b/i,
    /(पुणे|कोथरूड|औंध|बाणेर|हिंजवडी|वाकड|विमाननगर|खराडी|हडपसर|कोरेगाव ?पार्क|कल्याणी ?नगर|मगरपट्टा|डेक्कन|शिवाजीनगर|कात्रज|सिंहगड|पाषाण|बावधन|पिंपरी|चिंचवड)/,
  ] },
];

export function detectTopics(text: string): Topic[] {
  if (!text) return [];
  const found = new Set<Topic>();
  for (const rule of RULES) {
    if (rule.patterns.some((re) => re.test(text))) found.add(rule.topic);
  }
  return [...found];
}

export function topicsAsJson(topics: Topic[]): string {
  return JSON.stringify(topics);
}

export function parseTopics(json: string | null | undefined): Topic[] {
  if (!json) return [];
  try {
    const arr = JSON.parse(json);
    return Array.isArray(arr) ? (arr.filter((t) => typeof t === 'string') as Topic[]) : [];
  } catch {
    return [];
  }
}
