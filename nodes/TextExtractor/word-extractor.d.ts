declare module 'word-extractor' {
	interface Document {
		getBody(): string;
	}

	class WordExtractor {
		extract(buffer: Buffer): Promise<Document>;
	}

	export default WordExtractor;
}
