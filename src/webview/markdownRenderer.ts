import DOMPurify from 'dompurify';
import MarkdownIt from 'markdown-it';

const markdown = new MarkdownIt({
	html: false,
	linkify: true,
	breaks: false,
	typographer: false,
});

const markdownWithHtml = new MarkdownIt({
	html: true,
	linkify: true,
	breaks: false,
	typographer: false,
});

let allowRawHtml = window.crustInitialSettings?.allowRawHtml === true;

declare global {
	interface Window {
		crustInitialSettings?: {
			allowRawHtml?: boolean;
		};
		crustMarkdown?: {
			render(markdownSource: string): string;
			setAllowRawHtml(value: boolean): void;
		};
	}
}

window.crustMarkdown = {
	render(markdownSource: string): string {
		if (!allowRawHtml) {
			return markdown.render(markdownSource);
		}
		return DOMPurify.sanitize(markdownWithHtml.render(markdownSource), {
			FORBID_ATTR: ['style'],
			FORBID_TAGS: ['script', 'style'],
		});
	},
	setAllowRawHtml(value: boolean): void {
		allowRawHtml = value;
	},
};
