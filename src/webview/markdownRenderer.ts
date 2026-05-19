import DOMPurify from 'dompurify';
import MarkdownIt from 'markdown-it';

const markdown = new MarkdownIt({
	html: true,
	linkify: true,
	breaks: false,
	typographer: false,
});

declare global {
	interface Window {
		crustMarkdown?: {
			render(markdownSource: string): string;
		};
	}
}

window.crustMarkdown = {
	render(markdownSource: string): string {
		return DOMPurify.sanitize(markdown.render(markdownSource), {
			FORBID_ATTR: ['style'],
			FORBID_TAGS: ['script', 'style'],
		});
	},
};
