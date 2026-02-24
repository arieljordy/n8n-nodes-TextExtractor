import {
	IExecuteFunctions,
	INodeExecutionData,
	INodeType,
	INodeTypeDescription,
	NodeOperationError,
} from 'n8n-workflow';

import type { Worker } from 'tesseract.js';

// ---------- helpers: file type detection ----------

type FileType = 'image' | 'pdf' | 'docx' | 'doc' | 'txt';

const MIME_MAP: Record<string, FileType> = {
	'image/png': 'image',
	'image/jpeg': 'image',
	'image/jpg': 'image',
	'image/webp': 'image',
	'image/bmp': 'image',
	'image/tiff': 'image',
	'image/gif': 'image',
	'application/pdf': 'pdf',
	'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
	'application/msword': 'doc',
	'text/plain': 'txt',
};

const EXT_MAP: Record<string, FileType> = {
	png: 'image',
	jpg: 'image',
	jpeg: 'image',
	webp: 'image',
	bmp: 'image',
	tiff: 'image',
	tif: 'image',
	gif: 'image',
	pdf: 'pdf',
	docx: 'docx',
	doc: 'doc',
	txt: 'txt',
};

function detectFileType(mimeType?: string, fileName?: string): FileType | null {
	if (mimeType && MIME_MAP[mimeType]) return MIME_MAP[mimeType];
	if (fileName) {
		const ext = fileName.split('.').pop()?.toLowerCase();
		if (ext && EXT_MAP[ext]) return EXT_MAP[ext];
	}
	return null;
}

// ---------- extraction functions ----------

async function extractFromImage(
	buffer: Buffer,
	worker: Worker,
	preprocess: boolean,
): Promise<{ text: string; confidence: number | null }> {
	let input: Buffer = buffer;

	if (preprocess) {
		const sharp = (await import('sharp')).default;
		input = await sharp(buffer).greyscale().normalize().sharpen().toBuffer();
	}

	const {
		data: { text, confidence },
	} = await worker.recognize(input);

	return { text: text.trim(), confidence: Math.round(confidence) };
}

async function extractFromPdf(
	buffer: Buffer,
	strategy: string,
	worker: Worker | null,
	preprocess: boolean,
	renderScale: number,
	minTextThreshold: number,
): Promise<{
	text: string;
	pageCount: number;
	confidence: number | null;
	method: string;
}> {
	const shouldTryText = strategy === 'auto' || strategy === 'text';
	const shouldTryOcr = strategy === 'auto' || strategy === 'ocr';

	let textResult = '';
	let pageCount = 0;

	if (shouldTryText) {
		const { extractText, getDocumentProxy } = await import('unpdf');
		const pdf = await getDocumentProxy(new Uint8Array(buffer));
		pageCount = pdf.numPages;
		const { text } = await extractText(pdf, { mergePages: true });
		textResult = text.trim();
	}

	// If text strategy worked well enough, return it
	if (shouldTryText && textResult.length >= minTextThreshold) {
		return { text: textResult, pageCount, confidence: null, method: 'pdf-text' };
	}

	// OCR fallback
	if (shouldTryOcr && worker) {
		const { pdfToImages } = await import('./pdfToImages');
		const images = await pdfToImages(buffer, renderScale);
		pageCount = images.length;

		const texts: string[] = [];
		let totalConfidence = 0;

		for (const img of images) {
			const { text, confidence } = await extractFromImage(img, worker, preprocess);
			texts.push(text);
			totalConfidence += confidence ?? 0;
		}

		return {
			text: texts.join('\n\n'),
			pageCount,
			confidence: Math.round(totalConfidence / images.length),
			method: 'pdf-ocr',
		};
	}

	// Return whatever text extraction gave us
	return { text: textResult, pageCount, confidence: null, method: 'pdf-text' };
}

async function extractFromDocx(buffer: Buffer): Promise<string> {
	const mammoth = await import('mammoth');
	const { value } = await mammoth.extractRawText({ buffer });
	return value.trim();
}

async function extractFromDoc(buffer: Buffer): Promise<string> {
	const WordExtractor = (await import('word-extractor')).default;
	const extractor = new WordExtractor();
	const doc = await extractor.extract(buffer);
	return doc.getBody().trim();
}

function extractFromTxt(buffer: Buffer): string {
	return buffer.toString('utf-8').trim();
}

// ---------- node definition ----------

export class TextExtractor implements INodeType {
	description: INodeTypeDescription = {
		usableAsTool: true,
		displayName: 'Text Extractor',
		name: 'textExtractor',
		icon: 'file:textExtractor.svg',
		group: ['transform'],
		version: 1,
		subtitle: '={{ $parameter["operation"] }}',
		description: 'Extract text from images (OCR), PDFs, DOCX, DOC, and TXT files',
		defaults: {
			name: 'Text Extractor',
		},
		inputs: ['main'],
		outputs: ['main'],
		properties: [
			{
				displayName: 'Binary Property',
				name: 'binaryProperty',
				type: 'string',
				default: 'data',
				required: true,
				description: 'Name of the binary property containing the file to process. Falls back to the first available binary field if not found.',
			},
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				options: [
					{ name: 'Auto-Detect', value: 'auto' },
					{ name: 'OCR (Image)', value: 'ocr' },
					{ name: 'PDF', value: 'pdf' },
					{ name: 'Document (DOCX/DOC)', value: 'document' },
				],
				default: 'auto',
				description: 'How to process the file. Auto will detect the file type automatically.',
			},
			{
				displayName: 'OCR Language',
				name: 'ocrLanguage',
				type: 'options',
				options: [
					{ name: 'Arabic', value: 'ara' },
					{ name: 'Chinese Simplified', value: 'chi_sim' },
					{ name: 'Chinese Traditional', value: 'chi_tra' },
					{ name: 'Dutch', value: 'nld' },
					{ name: 'English', value: 'eng' },
					{ name: 'French', value: 'fra' },
					{ name: 'German', value: 'deu' },
					{ name: 'Hindi', value: 'hin' },
					{ name: 'Italian', value: 'ita' },
					{ name: 'Japanese', value: 'jpn' },
					{ name: 'Korean', value: 'kor' },
					{ name: 'Portuguese', value: 'por' },
					{ name: 'Russian', value: 'rus' },
					{ name: 'Spanish', value: 'spa' },
				],
				default: 'fra',
				description: 'Language for OCR text recognition',
			},
			{
				displayName: 'PDF Strategy',
				name: 'pdfStrategy',
				type: 'options',
				options: [
					{
						name: 'Auto',
						value: 'auto',
						description:
							'Try text extraction first, fall back to OCR if text is too short',
					},
					{
						name: 'Text Only',
						value: 'text',
						description: 'Extract embedded text only (fast, no OCR)',
					},
					{
						name: 'OCR Only',
						value: 'ocr',
						description: 'Convert pages to images and OCR them',
					},
				],
				default: 'auto',
				displayOptions: {
					show: {
						operation: ['auto', 'pdf'],
					},
				},
				description: 'Strategy for extracting text from PDFs',
			},
			{
				displayName: 'Preprocess Images',
				name: 'preprocess',
				type: 'boolean',
				default: true,
				description:
					'Whether to preprocess images before OCR (greyscale, normalize, sharpen) for better accuracy',
			},
			{
				displayName: 'PDF Render Scale',
				name: 'pdfRenderScale',
				type: 'number',
				default: 2,
				typeOptions: {
					minValue: 1,
					maxValue: 4,
				},
				displayOptions: {
					show: {
						operation: ['auto', 'pdf'],
					},
				},
				description: 'Scale factor for rendering PDF pages to images (higher = better quality but slower)',
			},
			{
				displayName: 'Minimum Text Threshold',
				name: 'minTextThreshold',
				type: 'number',
				default: 50,
				displayOptions: {
					show: {
						pdfStrategy: ['auto'],
					},
				},
				description:
					'Minimum number of characters from text extraction before falling back to OCR (for auto PDF strategy)',
			},
		],
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();
		const returnData: INodeExecutionData[] = [];

		const binaryProperty = this.getNodeParameter('binaryProperty', 0) as string;
		const operation = this.getNodeParameter('operation', 0) as string;
		const ocrLanguage = this.getNodeParameter('ocrLanguage', 0) as string;
		const preprocess = this.getNodeParameter('preprocess', 0) as boolean;

		let worker: Worker | null = null;

		try {
			for (let i = 0; i < items.length; i++) {
				try {
					// Resolve binary field: use configured name, or fall back to first available binary field
					let resolvedProperty = binaryProperty;
					if (!items[i].binary?.[binaryProperty]) {
						const binaryKeys = Object.keys(items[i].binary ?? {});
						if (binaryKeys.length > 0) {
							resolvedProperty = binaryKeys[0];
						}
					}

					const binaryData = this.helpers.assertBinaryData(i, resolvedProperty);
					const buffer = await this.helpers.getBinaryDataBuffer(i, resolvedProperty);

					const fileName = binaryData.fileName ?? 'unknown';
					const mimeType = binaryData.mimeType ?? '';

					// Determine file type
					let fileType: FileType | null;
					if (operation === 'auto') {
						fileType = detectFileType(mimeType, fileName);
					} else if (operation === 'ocr') {
						fileType = 'image';
					} else if (operation === 'pdf') {
						fileType = 'pdf';
					} else {
						// document
						const detected = detectFileType(mimeType, fileName);
						fileType = detected === 'doc' || detected === 'docx' ? detected : 'docx';
					}

					if (!fileType) {
						throw new NodeOperationError(
							this.getNode(),
							`Unsupported file type: ${mimeType || fileName}`,
							{ itemIndex: i },
						);
					}

					// Init Tesseract worker lazily when needed
					const needsOcr =
						fileType === 'image' ||
						(fileType === 'pdf' &&
							((this.getNodeParameter('pdfStrategy', i, 'auto') as string) !== 'text'));

					if (needsOcr && !worker) {
						const Tesseract = await import('tesseract.js');
						worker = await Tesseract.createWorker(ocrLanguage);
					}

					let text = '';
					let pageCount: number | null = null;
					let confidence: number | null = null;
					let method = '';

					switch (fileType) {
						case 'image': {
							const result = await extractFromImage(buffer, worker!, preprocess);
							text = result.text;
							confidence = result.confidence;
							method = 'ocr';
							break;
						}
						case 'pdf': {
							const pdfStrategy = this.getNodeParameter('pdfStrategy', i, 'auto') as string;
							const renderScale = this.getNodeParameter('pdfRenderScale', i, 2) as number;
							const minThreshold = this.getNodeParameter(
								'minTextThreshold',
								i,
								50,
							) as number;
							const result = await extractFromPdf(
								buffer,
								pdfStrategy,
								worker,
								preprocess,
								renderScale,
								minThreshold,
							);
							text = result.text;
							pageCount = result.pageCount;
							confidence = result.confidence;
							method = result.method;
							break;
						}
						case 'docx': {
							text = await extractFromDocx(buffer);
							method = 'docx';
							break;
						}
						case 'doc': {
							text = await extractFromDoc(buffer);
							method = 'doc';
							break;
						}
						case 'txt': {
							text = extractFromTxt(buffer);
							method = 'txt';
							break;
						}
					}

					returnData.push({
						json: {
							text,
							fileName,
							mimeType,
							fileType,
							pageCount,
							confidence,
							language: needsOcr ? ocrLanguage : null,
							method,
						},
					});
				} catch (error) {
					if (this.continueOnFail()) {
						const resolvedProp = binaryProperty;
						const binaryData = items[i].binary?.[resolvedProp]
							?? Object.values(items[i].binary ?? {})[0];
						returnData.push({
							json: {
								error: (error as Error).message,
								fileName: binaryData?.fileName ?? 'unknown',
								mimeType: binaryData?.mimeType ?? '',
								fileType: null,
								pageCount: null,
								confidence: null,
								language: null,
								method: null,
							},
						});
						continue;
					}
					throw error;
				}
			}
		} finally {
			if (worker) {
				await worker.terminate();
			}
		}

		return [returnData];
	}
}
