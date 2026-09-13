export type Verdict = 'meaningful' | 'marginal' | 'noise';

export type DateMetrics = {
	d: number;
	xirr: number;
	corpus: number;
	meanPct: number;
	topQ: number;
};

export type FundArtifact = {
	code: number;
	name: string;
	house: string;
	category: string;
	navFrom: string;
	navTo: string;
	instalments: number;
	dates: DateMetrics[];
	spreadPp: number;
	spreadRupees: number;
	stability: number;
	metricsAgree: boolean;
	verdict: Verdict;
};

export type IndexRow = [code: number, name: string, house: string, category: string];

export type MetaFile = {
	builtAt: string;
	fundCount: number;
	navAsOf: string;
	pipelineVersion: string;
};
