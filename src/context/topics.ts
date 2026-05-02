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
  | 'politics'
  | 'civic'
  | 'crime'
  | 'weather'
  | 'festival'
  | 'pune-area';

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
