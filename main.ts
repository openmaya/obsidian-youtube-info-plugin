import { Editor, MarkdownRenderer, MarkdownRenderChild, Plugin, MarkdownView, Notice, requestUrl, RequestUrlParam, MarkdownPostProcessorContext, EditorPosition, TAbstractFile } from 'obsidian';
import ThumbySettingTab from "./settings";

interface VidInfo {
	url: string;
	thumbnail: string;
	title: string;
	author: string;
	authorUrl: string;
	vidFound: boolean;
	networkError: boolean;
}

interface ThumbySettings {
	youtubeApiKey: string;
}

const DEFAULT_SETTINGS: Partial<ThumbySettings> = {
	youtubeApiKey: ''
};

const URL_TYPES = {
	youtube: [
		{match: 'https://www.youtube.com/watch?v=', idPattern: /v=([-\w\d]+)/},
		{match: 'https://youtu.be/', idPattern: /youtu.be\/([-\w\d]+)/},
		{match: 'youtube.com/shorts/', idPattern: /shorts\/([-\w\d]+)/},
		{match: 'youtube.com/live/', idPattern: /live\/(\w+)/}
	],
	vimeo: [
		{match: 'https://vimeo.com/', idPattern: /vimeo.com\/([\w\d]+)/}
	]
};

export default class ThumbyPlugin extends Plugin {
	settings: ThumbySettings;
	private editorObserver: ResizeObserver;

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	async onload() {
		await this.loadSettings();
		this.addSettingTab(new ThumbySettingTab(this.app, this));

		// mark down Processor
		this.registerMarkdownCodeBlockProcessor('vidy', async (source, el, ctx) => {

			this.createDummyBlock(el);
			const sourceLines = source.trim().split('\n');
			const url = sourceLines[0];
			const info: VidInfo = await this.getVideoInfo(url);

			const sourcePath =
				typeof ctx == "string"
					? ctx
					: ctx?.sourcePath ??
					this.app.workspace.getActiveFile()?.path ??
					"";

			if (!info.vidFound) {
				const component = new MarkdownRenderChild(el);
				this.removeDummyBlock(el);
				MarkdownRenderer.renderMarkdown(
					`>[!WARNING] Cannot find video\n>${info.url}`,
					el,
					sourcePath,
					component
				);
				return;
			}

			if (this.hasManyUrls(sourceLines)){
				const component = new MarkdownRenderChild(el);
				this.removeDummyBlock(el);
				MarkdownRenderer.renderMarkdown(
					`>[!WARNING] Cannot accept multiple URLs yet`,
					el,
					sourcePath,
					component
				);
				return;
			}

			if (sourceLines.length > 1) {
				this.removeStoredInfo(info, el, ctx);
			}

			this.removeDummyBlock(el);
			this.createThumbnail(el, info);
		});

		
		this.addCommand({
			id: "insert-youtube-info-from-clipboard",
			name: "Insert youtube-info from URL in clipboard",
			editorCallback: async (editor: Editor, view: MarkdownView) => {
				const clipText = await navigator.clipboard.readText();
				const id = await this.getVideoId(clipText);
				if (id === '') {
					new Notice('No valid video in clipboard', 2000);
					return;
				}
				editor.replaceSelection(`\`\`\`vidy\n${clipText}\n\`\`\``);
			}
		});

		this.addCommand({
			id: "insert-video-title-link",
			name: "Insert video title link from URL in clipboard",
			editorCallback: async (editor: Editor, view: MarkdownView) => {
				const clipText = await navigator.clipboard.readText();
				const id = await this.getVideoId(clipText);
				if (id === "") {
					new Notice("No valid video in clipboard", 2000);
					return;
				}
				const info = await this.getVideoInfo(clipText);

				editor.replaceSelection(`[${info.title}](${info.url})`);
			}
		});
	}

	onunload() {
		if (this.editorObserver) {
			this.editorObserver.disconnect();
		}
	}

	hasManyUrls(lines: string[]): boolean{
		// Will be used for future features
		return (lines.length > 1 && lines.every(e => (/^((https*:\/\/)|(www\.))+\S*$/).test(e.trim())))
	}

	createThumbnail(el: HTMLElement, info: VidInfo) {
		const thumbnailUrl = info.thumbnail;
		const container = el.createEl('a', { href: info.url });
		container.addClass('thumbnail');
		const imgEl = container.createEl('img', { attr: { 'src': thumbnailUrl } });
		imgEl.addClass("thumbnail-img");
		const textBox = container.createDiv();
		textBox.addClass('thumbnail-text');
		textBox.createEl('p', {text: info.title, title: info.title}).addClass('thumbnail-title');
		textBox.createEl('a', {text: info.author, href: info.authorUrl, title: info.author}).addClass('thumbnail-author');
	}

	createDummyBlock(el: HTMLElement) {
		const container = el.createDiv();
		container.addClass('dummy-container');
	}

	removeDummyBlock(el: HTMLElement) {
		const dummy = el.querySelector('.dummy-container');
		if(dummy){
			el.removeChild(dummy);
		}
	}

	pathIsLocal(path: string): boolean{
		return path.indexOf('https://') !== 0;
	}

	getTrimmedResourcePath(file: TAbstractFile): string {
		//@ts-ignore
		const path = this.app.vault.getResourcePath(file);
		const endPos = path.indexOf('.jpg') + 4;
		return path.substring(0, endPos);
	}

	removeStoredInfo(info: VidInfo, el: HTMLElement, ctx: MarkdownPostProcessorContext) {
		const section = ctx.getSectionInfo(el);

		if (!section) {
			return;
		}

		const content = `\`\`\`vidy\n${info.url}\n\`\`\``;

		const view = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (view) {
			const startPos: EditorPosition = {
				line: section.lineStart,
				ch: 0
			};

			const endPos: EditorPosition = {
				line: section.lineEnd,
				ch: view.editor.getLine(section.lineEnd).length
			}

			view.editor.replaceRange(content, startPos, endPos);
		}
	}

	async getVideoInfo(url: string): Promise<VidInfo> {
		const info: VidInfo = {
			url: url,
			thumbnail: '',
			title: '',
			author: '',
			authorUrl: '',
			vidFound: false,
			networkError: false
		};
		let reqUrl = '';
		let isYoutube = false;
		for (const type of URL_TYPES.youtube) {
			if(url.includes(type.match)){
				isYoutube = true;
			}
		}
		let isVimeo = false;
		for (const type of URL_TYPES.vimeo) {
			if (url.includes(type.match)) {
				isVimeo = true;
			}
		}

		// Use oEmbed to get data (https://oembed.com/)
		if (isYoutube) {
			reqUrl = `https://www.youtube.com/oembed?format=json&url=${url}`;
		}
		else if (isVimeo) {
			reqUrl = `https://vimeo.com/api/oembed.json?url=${url}`;
		}
		else {
			//vid not found
			return info;
		}

		try {
			const reqParam: RequestUrlParam = {
				url: reqUrl,
				throw: false
			};
			const res = await requestUrl(reqParam);

			if (res.status === 200) {
				info.title = res.json.title;
				info.author = res.json.author_name;
				info.authorUrl = res.json.author_url;
				info.vidFound = true;
			}
			else if(this.settings.youtubeApiKey && isYoutube) {

				const videoId = await this.getVideoId(url);
				const youtubeUrl = `https://youtube.googleapis.com/youtube/v3/videos?part=snippet&id=${videoId}&key=${this.settings.youtubeApiKey}`;
				const youtubeReqParam: RequestUrlParam = {
					url: youtubeUrl,
					throw: false
				};
				const youtubeApiRes = await requestUrl(youtubeReqParam);

				if (youtubeApiRes.status === 200) {
					const vidSnippet = youtubeApiRes.json.items[0].snippet;

					info.authorUrl = 'javascript:void(0)';
					const channelQueryUrl = `https://youtube.googleapis.com/youtube/v3/channels?part=snippet&id=${vidSnippet.channelId}&key=${this.settings.youtubeApiKey}`;
					const channelQueryParam: RequestUrlParam = {
						url: channelQueryUrl,
						throw: false
					};
					const channelQueryRes = await requestUrl(channelQueryParam);

					if(channelQueryRes.status === 200){
						const channelSnippet = channelQueryRes.json.items[0].snippet;
						const channelCustomUrl = channelSnippet.customUrl;
						const channelUrl = `https://www.youtube.com/${channelCustomUrl}`;
						info.authorUrl = channelUrl;
					}

					info.title = vidSnippet.title;
					info.author = vidSnippet.channelTitle;
					// The api doesn't give back an author url. Could make another API call to find author url using channel ID.
					// To avoid making another API call, I'm just making it an empty link.
					// info.authorUrl = 'javascript:void(0);';
					info.vidFound = true;
				}
			}

			if (info.vidFound) {
				if (isYoutube) {
					// Returned thumbnail is usually letterboxed or wrong aspect ratio
					const videoId = await this.getVideoId(url);
					info.thumbnail = `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`;
				}
				else {
					info.thumbnail = res.json.thumbnail_url;
				}
			}
		} catch (error) {
			console.error(error);
			// Network error
			info.networkError = true;
		}

		return info;
	}

	async getVideoId(url: string): Promise<string> {
		
		let id = '';
		for (const type of URL_TYPES.youtube) {
			if(url.includes(type.match)){
				const matches = url.match(type.idPattern);
				if(matches !== null){
					id = matches[1];
				}
			}
		}
		
		const vimeoType = URL_TYPES.vimeo[0];
		if (url.includes(vimeoType.match)) {
			const matches = url.match(vimeoType.idPattern);
			if (matches !== null) {
				id = matches[1];
				if (!(/^[0-9]+$/).exec(id)) {
					// Special vimeo url's that don't contain a video id
					id = await this.fetchVimeoVideoId(url);
				}
			}
		}
		return id;
	}

	async fetchVimeoVideoId(url: string): Promise<string> {
		let id = '';
		try {
			const reqParam: RequestUrlParam = {
				url: `https://vimeo.com/api/oembed.json?url=${url}`
			};

			const res = await requestUrl(reqParam);

			if (res.status === 200 && res.json.video_id) {
				id = res.json.video_id.toString();
			}
		} catch (error) {
			console.error(error);
		}
		return id;
	}
}
