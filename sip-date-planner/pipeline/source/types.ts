export type NavHistory = {
	meta: {
		scheme_code: number;
		scheme_name: string;
		scheme_category: string;
		fund_house: string;
		scheme_type: string;
		isin_growth?: string | null;
	};
	data: { date: string; nav: string }[];
};

export type NavSource = {
	id: string;
	listSchemes(): Promise<{ schemeCode: number; schemeName: string }[]>;
	fetchHistory(schemeCode: number): Promise<NavHistory>;
};
