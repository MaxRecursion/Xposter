export type SalaryChoice = number | 'lwd';

const WINDOW_LEN = 10;

export function wrapDay(n: number): number {
	return ((((n - 1) % 28) + 28) % 28) + 1;
}

/** Safe instalment days (1–28). Last working day defaults to 3rd–12th when buffer is 2. */
export function safeWindow(salary: SalaryChoice, buffer: number): number[] {
	const days: number[] = [];
	if (salary === 'lwd') {
		const start = 1 + buffer;
		for (let i = 0; i < WINDOW_LEN; i += 1) days.push(wrapDay(start + i));
		return days;
	}
	const start = wrapDay(salary + buffer);
	for (let i = 0; i < WINDOW_LEN; i += 1) days.push(wrapDay(start + i));
	return days;
}

export function parseSalaryParam(raw: string | null): SalaryChoice {
	if (raw == null || raw === '' || raw === 'lwd' || raw === '28') return 'lwd';
	const n = Number(raw);
	if (Number.isInteger(n) && n >= 1 && n <= 28) return n === 28 ? 'lwd' : n;
	return 'lwd';
}

export function parseBufferParam(raw: string | null): number {
	const n = Number(raw);
	if (Number.isInteger(n) && n >= 0 && n <= 10) return n;
	return 2;
}

export function salaryToParam(salary: SalaryChoice): number {
	return salary === 'lwd' ? 28 : salary;
}
