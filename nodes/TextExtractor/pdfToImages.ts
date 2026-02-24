import { pdfToPng } from 'pdf-to-png-converter';

export async function pdfToImages(pdfBuffer: Buffer, scale: number): Promise<Buffer[]> {
	const pages = await pdfToPng(pdfBuffer.buffer as ArrayBuffer, {
		viewportScale: scale,
	});
	return pages
		.map((page) => page.content)
		.filter((content): content is Buffer => content !== undefined);
}
