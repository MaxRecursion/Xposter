/**
 * The Xposter "brain": a related-source catalog plus a topic graph that
 * retrieval and reply prompts share.
 *
 * Sources in the brain are Pune civic life, Maharashtra, and the India
 * jobs/AI/startup economy. Opt-in feeds (gadgets, world geopolitics, space)
 * stay available via env but do not pollute default ingest.
 */
import { buildNeuralSchemaMemory, loadMemoryEvents } from './neural_memory.js';
import { listContextSourceCatalog, type BrainCluster } from './sources/index.js';
import {
  expandLinkedTopics,
  formatTopicWeb,
  listStaticTopicLinks,
  loadCorpusTopicNeighbors,
  type TopicLink,
} from './topic_graph.js';
import { detectTopics, type Topic } from './topics.js';

export interface BrainRecall {
  seedTopics: Topic[];
  linkedTopics: Topic[];
  topicWeb: string;
  promptBlock: string;
}

export interface BrainSnapshot {
  clusters: Array<{ cluster: BrainCluster; label: string; sourceCount: number }>;
  sources: Array<{
    name: string;
    cluster: BrainCluster;
    inBrain: boolean;
    active: boolean;
  }>;
  topicLinks: TopicLink[];
  corpusNeighbors: Array<{ topic: string; neighbors: string[] }>;
  memory: {
    concepts: number;
    links: number;
    events: number;
    topConcepts: string[];
  };
}

const CLUSTER_LABELS: Record<BrainCluster, string> = {
  'pune-civic': 'Pune civic & weather',
  'india-work': 'India jobs, startups, economy',
  'ai-tech': 'AI / tech (jobs lens)',
  'opt-in': 'Opt-in (not in default brain)',
};

export function recallBrainTopics(query: string): BrainRecall {
  const seedTopics = detectTopics(query);
  const corpusNeighbors = loadCorpusTopicNeighbors();
  const linkedTopics = expandLinkedTopics(seedTopics, { hops: 1, corpusNeighbors });
  const topicWeb = formatTopicWeb(seedTopics, linkedTopics);
  const promptBlock = topicWeb
    ? [
      '[TOPIC BRAIN]',
      `Related topics: ${topicWeb}`,
      'Use a concrete fact that sits in this neighborhood when it fits the tweet. Do not drag in a linked topic that is not actually in the tweet.',
      '[/TOPIC BRAIN]',
    ].join('\n')
    : '';
  return { seedTopics, linkedTopics, topicWeb, promptBlock };
}

export function getBrainSnapshot(): BrainSnapshot {
  const catalog = listContextSourceCatalog();
  const clusterCounts = new Map<BrainCluster, number>();
  for (const row of catalog) {
    if (!row.active) continue;
    clusterCounts.set(row.cluster, (clusterCounts.get(row.cluster) ?? 0) + 1);
  }

  const corpus = loadCorpusTopicNeighbors();
  const corpusNeighbors = [...corpus.entries()].map(([topic, neighbors]) => ({
    topic,
    neighbors,
  }));

  let memory = { concepts: 0, links: 0, events: 0, topConcepts: [] as string[] };
  try {
    const events = loadMemoryEvents(180);
    const graph = buildNeuralSchemaMemory(events);
    memory = {
      concepts: graph.nodes.length,
      links: graph.edges.length,
      events: graph.events.length,
      topConcepts: graph.nodes.slice(0, 12).map((n) => n.key),
    };
  } catch {
    // Brain snapshot should still render source/topic data if memory is empty.
  }

  return {
    clusters: (Object.keys(CLUSTER_LABELS) as BrainCluster[])
      .filter((cluster) => cluster !== 'opt-in' || (clusterCounts.get(cluster) ?? 0) > 0)
      .map((cluster) => ({
        cluster,
        label: CLUSTER_LABELS[cluster],
        sourceCount: clusterCounts.get(cluster) ?? 0,
      })),
    sources: catalog,
    topicLinks: listStaticTopicLinks(),
    corpusNeighbors,
    memory,
  };
}
