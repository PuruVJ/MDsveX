//@ts-ignore
import retext from 'retext';
//@ts-ignore
import smartypants from 'retext-smartypants';
import visit from 'unist-util-visit';
import yaml from 'js-yaml';
import { parse } from 'svelte/compiler';
import escape from 'escape-html';

import type { Transformer } from 'unified';
import type { Node } from 'unist';
import type { HTML, Text, Code } from 'mdast';
import type { Element, Root } from 'hast';
import { message, VFile } from 'vfile';
// this needs a big old cleanup

const newline = '\n';
// extract the yaml from 'yaml' nodes and put them in the vfil for later use

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function default_frontmatter(
	value: string, // eslint-disable-next-line @typescript-eslint/no-explicit-any
	messages: any[] // eslint-disable-next-line @typescript-eslint/ban-types
): string | object | undefined {
	try {
		return yaml.safeLoad(value);
	} catch (e) {
		messages.push(['YAML failed to parse', e]);
	}
}

type parser_frontmatter_options = {
	parse: (
		value: string, // eslint-disable-next-line @typescript-eslint/no-explicit-any
		message: any[] // eslint-disable-next-line @typescript-eslint/no-explicit-any
	) => undefined | { [x: string]: any };
	type: string;
};

interface FrontMatterNode extends Node {
	type: string;
	value: string;
}

export function parse_frontmatter({
	parse,
	type,
}: parser_frontmatter_options): Transformer {
	const transformer: Transformer = (tree, vFile) => {
		visit(tree, type, (node: FrontMatterNode) => {
			const data = parse(node.value, vFile.messages);
			if (data) {
				// @ts-ignore
				vFile.data.fm = data;
			}
		});
	};

	return transformer;
}

// in code nodes replace the character witrh the html entities
// maybe I'll need more of these

const entites: Array<[RegExp, string]> = [
	[/</g, '&lt;'],
	[/>/g, '&gt;'],
	[/{/g, '&#123;'],
	[/}/g, '&#125;'],
];

export function escape_code({ blocks }: { blocks: boolean }): Transformer {
	return function (tree) {
		if (!blocks) {
			visit(tree, 'code', escape);
		}

		visit(tree, 'inlineCode', escape);

		function escape(node: FrontMatterNode) {
			for (let i = 0; i < entites.length; i += 1) {
				node.value = node.value.replace(entites[i][0], entites[i][1]);
			}
		}
	};
}

// special case - process nodes with retext and smarypants
// retext plugins can't work generally due to the difficulties in converting between the two trees

export function smartypants_transformer(options = {}): Transformer {
	const processor = retext().use(smartypants, options);

	return function (tree) {
		visit(tree, 'text', (node) => {
			node.value = String(processor.processSync(node.value));
		});
	};
}

// regex for scripts and attributes

const attrs = `(?:\\s{0,1}[a-zA-z]+=(?:"){0,1}[a-zA-Z0-9]+(?:"){0,1})*`;
const context = `(?:\\s{0,1}context)=(?:"){0,1}module(?:"){0,1}`;

const RE_BLANK = /^\n+$|^\s+$/;

const RE_SCRIPT = new RegExp(`^(<script` + attrs + `>)`);

const RE_MODULE_SCRIPT = new RegExp(
	`^(<script` + attrs + context + attrs + `>)`
);

function map_layout_to_path(
	filename: string,
	layout_map: { [x: string]: string }
): string | undefined {
	const match = Object.keys(layout_map).find((l) =>
		new RegExp(`\\/${l}\\/`).test(filename.replace(process.cwd(), ''))
	);

	if (match) {
		return layout_map[match];
	} else {
		return layout_map['_'] ? layout_map['_'] : undefined;
	}
}

type parts = {
	special: Node[];
	html: Array<Element | Text | (Node & { type: 'raw' })>;
	instance: Node[];
	module: Node[];
	css: Node[];
};

function extract_parts(nodes: Array<Element | Text>): parts {
	// since we are wrapping and replacing we need to keep track of the different component 'parts'
	// many special tags cannot be wrapped nor can style or script tags
	const parts: parts = {
		special: [],
		html: [],
		instance: [],
		module: [],
		css: [],
	};

	// iterate through all top level child nodes and assign them to the correct 'part'
	// anything that is a normal HAST node gets stored as HTML untouched
	// everything else gets parsed by the svelte parser

	children: for (let i = 0; i < nodes.length; i += 1) {
		const empty_node =
			nodes[i].type === 'text' && RE_BLANK.exec(nodes[i].value as string);

		// i no longer knwo why i did this

		if (empty_node || !nodes[i].value) {
			if (
				!parts.html.length ||
				!(
					RE_BLANK.exec(nodes[i].value as string) &&
					RE_BLANK.exec(parts.html[parts.html.length - 1].value as string)
				)
			) {
				parts.html.push(nodes[i]);
			}

			continue children;
		}

		// @ts-ignore
		let result: {
			html?:
				| {
						children?: any[] | undefined;
						start: any;
						end: any;
						[x: string]: any;
				  }
				| undefined;
			instance?: any;
			module?: any;
			// [x: string]: any;
		};
		try {
			result = parse(nodes[i].value as string);
		} catch (e) {
			parts.html.push(nodes[i]);
			continue children;
		}

		// svelte special tags that have to be top level
		if (!result.html?.children) return parts;

		const _parts: Array<[
			'html' | 'css' | 'special' | 'instance' | 'module',
			number,
			number
		]> = result.html.children.map((v) => {
			if (
				v.type === 'Options' ||
				v.type === 'Head' ||
				v.type === 'Window' ||
				v.type === 'Body'
			) {
				return ['special', v.start, v.end];
			} else {
				return ['html', v.start, v.end];
			}
		});

		results: for (const key in result) {
			if (key === 'html' || !result[key as 'html' | 'instance' | 'module'])
				continue results;
			_parts.push([
				key as 'html' | 'instance' | 'module',
				result[key as 'html' | 'instance' | 'module'].start,
				result[key as 'html' | 'instance' | 'module'].end,
			]);
		}

		// sort them to ensure the array is in the order they appear in the source, no gaps
		// this might not be necessary any more, i forget
		const sorted = _parts.sort((a, b) => a[1] - b[1]);

		// push the nodes into the correct 'part' since they are sorted everything should be in the correct order
		sorted.forEach((next) => {
			parts[next[0]].push({
				type: 'raw',
				value: (nodes[i].value as string).substring(next[1], next[2]),
			});
		});
	}

	return parts;
}

type MdsvexVFile = VFile & {
	filename: string;
	data?: {
		fm?: Record<string, unknown>;
	};
};

type MdsvexTransformer = (
	node: Node,
	file: MdsvexVFile,
	next?: (
		error: Error | null,
		tree: Node,
		file: VFile
	) => Record<string, unknown>
) => Error | Node | Promise<Node> | void | Promise<void>;

export function transform_hast({
	layout,
}: {
	layout: { [x: string]: string } | 'string';
}): MdsvexTransformer {
	return function transformer(tree, vFile: MdsvexVFile) {
		// we need to keep { and } intact for svelte, so reverse the escaping in links and images
		// if anyone actually uses these characters for any other reason i'll probably just cry
		visit<Element>(tree, 'element', (node) => {
			if (node.tagName === 'a' && typeof node?.properties?.href === 'string') {
				node.properties.href = node.properties.href
					.replace(/%7B/g, '{')
					.replace(/%7D/g, '}');
			}

			if (node.tagName === 'img' && typeof node?.properties?.src === 'string') {
				node.properties.src = node.properties.src
					.replace(/%7B/g, '{')
					.replace(/%7D/g, '}');
			}
		});

		// the rest only applies to layouts and front matter
		// this  breaks position data
		// svelte preprocessors don't currently support sourcemaps
		// i'll fix this when they do

		//@ts-ignore
		if (!layout && !vFile.data.fm) return;

		visit<{ type: string; children: Array<Element | Text> }>(
			tree,
			'root',
			(node) => {
				const { special, html, instance, module: _module, css } = extract_parts(
					node.children
				);

				const fm =
					vFile?.data?.fm &&
					`export const metadata = ${JSON.stringify(
						vFile.data.fm
					)};${newline}` +
						`\tconst { ${Object.keys(vFile.data.fm).join(', ')} } = metadata;`;

				const _fm_layout = vFile?.data?.fm?.layout;

				type layout_obj = { components: []; path: string };
				let _layout: string | boolean | undefined | layout_obj;

				// passing false in fm forces no layout
				if (_fm_layout === false) _layout = false;
				// no frontmatter layout provided
				else if (_fm_layout === undefined) {
					// both layouts undefined

					if (layout === undefined) {
						_layout = false;

						// a single layout was passed to options, so always use it
					} else if (typeof layout !== 'string' && layout.__mdsvex_default) {
						_layout = layout.__mdsvex_default;

						// multiple layouts were passed to options, so map folder to layout
					} else if (typeof layout === 'object' && layout !== null) {
						_layout = map_layout_to_path(vFile.filename, layout);

						if (_layout === undefined)
							vFile.messages.push(
								message(
									`Could not find a matching layout for ${vFile.filename}.`
								)
							);
					}

					// front matter layout is a string
				} else if (typeof _fm_layout === 'string') {
					// options layout is a string, so this doesn't make sense: recover but warn
					if (typeof layout !== 'string' && layout.__mdsvex_default) {
						_layout = false;

						vFile.messages.push(
							message(
								`You attempted to apply a named layout in the front-matter of ${vFile.filename}, but did not provide any named layouts as options to the preprocessor. `,
								{
									start: { line: 0, column: 0, offset: 0 },
									end: { line: 0, column: 0, offset: 0 },
								}
							)
						);

						// options layout is an object so do a simple lookup
					} else if (typeof layout === 'object' && layout !== null) {
						_layout = layout[_fm_layout] || layout['*'];

						if (_layout === undefined)
							vFile.messages.push(
								message(
									`Could not find a layout with the name ${_fm_layout} and no fall back ('*') was provided.`
								)
							);
					}
				}

				if (
					_layout &&
					(_layout as layout_obj).components &&
					(_layout as layout_obj).components.length
				) {
					for (let i = 0; i < (_layout as layout_obj).components.length; i++) {
						visit(tree, 'element', (node) => {
							if (node.tagName === (_layout as layout_obj).components[i]) {
								node.tagName = `Components.${
									(_layout as layout_obj).components[i]
								}`;
							}
						});
					}
				}

				const layout_import =
					_layout &&
					`import Layout_MDSVEX_DEFAULT${
						(_layout as layout_obj).components ? `, * as Components` : ''
					} from '${(_layout as { path: string }).path}';`;

				// add the layout if we are using one, reusing the existing script if one exists
				if (_layout && !instance[0]) {
					instance.push({
						type: 'raw',
						value: `${newline}<script>${newline}\t${layout_import}${newline}</script>${newline}`,
					});
				} else if (_layout) {
					instance[0].value = (instance[0].value as string).replace(
						RE_SCRIPT,
						`$1${newline}\t${layout_import}`
					);
				}

				// inject the frontmatter into the module script if there is any, reusing the existing module script if one exists
				if (!_module[0] && fm) {
					_module.push({
						type: 'raw',
						value: `<script context="module">${newline}\t${fm}${newline}</script>`,
					});
				} else if (fm) {
					_module[0].value = _module[0].value.replace(
						RE_MODULE_SCRIPT,
						`$1${newline}\t${fm}`
					);
				}

				// smoosh it all together in an order that makes sense,
				// if using a layout we only wrap the html and nothing else
				//@ts-ignore
				node.children = [
					..._module,
					{ type: 'raw', value: _module[0] ? newline : '' },
					...instance,
					{ type: 'raw', value: instance[0] ? newline : '' },
					...css,
					{ type: 'raw', value: css[0] ? newline : '' },
					...special,
					{ type: 'raw', value: special[0] ? newline : '' },
					{
						type: 'raw',
						value: _layout
							? `<Layout_MDSVEX_DEFAULT${fm ? ' {...metadata}' : ''}>`
							: '',
					},
					{ type: 'raw', value: newline },
					...html,
					{ type: 'raw', value: newline },
					{ type: 'raw', value: _layout ? '</Layout_MDSVEX_DEFAULT>' : '' },
				];
			}
		);
	};
}

// highlighting stuff

// { [lang]: { path, deps: pointer to key } }
const langs: { [x: string]: lang_def } = {};
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let Prism: any;

const make_path = (base_path: string, id: string) =>
	base_path.replace('{id}', id);

// we need to get all language metadata
// also track if they depend on other languages so we can autoload without breaking
// i don't actually know what the require key means but it sounds important

type lang_meta = {
	require?: string[];
	peerDependencies?: string[];
	alias?: string[];
};

type lang_def = {
	aliases: Set<unknown>;
	name: string;
	path: string;
	deps: Set<string>;
};

function get_lang_info(
	name: string,
	lang_meta: lang_meta,
	base_path: string
): [lang_def, Set<string>] {
	const _lang_meta = {
		name,
		path: `prismjs/${make_path(base_path, name)}`,
		deps: new Set<string>(),
	};

	const aliases = new Set<string>();

	// todo: DRY this up, it is literally identical

	if (lang_meta.require) {
		if (Array.isArray(lang_meta.require)) {
			lang_meta.require.forEach((id) => _lang_meta.deps.add(id));
		} else {
			_lang_meta.deps.add(lang_meta.require);
		}
	}

	if (lang_meta.peerDependencies) {
		if (Array.isArray(lang_meta.peerDependencies)) {
			lang_meta.peerDependencies.forEach((id) => _lang_meta.deps.add(id));
		} else {
			_lang_meta.deps.add(lang_meta.peerDependencies);
		}
	}

	if (lang_meta.alias) {
		if (Array.isArray(lang_meta.alias)) {
			lang_meta.alias.forEach((id) => aliases.add(id));
		} else {
			aliases.add(lang_meta.alias);
		}
	}

	return [{ ..._lang_meta, aliases }, aliases];
}

type rollup_process = NodeJS.Process & { browser: boolean };

type prism_meta = {
	path: string;
	noCSS: boolean;
	examplesPath: string;
	addCheckAll: boolean;
};

type prism_lang = {
	require?: string[];
	peerDependencies?: string[];
	alias?: string[];
};

function load_language_metadata() {
	if (!(process as rollup_process).browser) {
		const {
			meta,
			...languages
		}: {
			meta: prism_meta;
			[x: string]: prism_lang; // eslint-disable-next-line @typescript-eslint/no-var-requires
		} = require('prismjs/components.json').languages;

		for (const lang in languages) {
			const [lang_info, aliases] = get_lang_info(
				lang,
				languages[lang],
				meta.path
			);

			langs[lang] = lang_info;
			aliases.forEach((_n) => {
				langs[_n] = langs[lang];
			});
		}
	}
}

function load_language(lang: string) {
	if (!(process as rollup_process).browser) {
		if (!langs[lang]) return;

		langs[lang].deps.forEach((name) => load_language(name));

		require(langs[lang].path);
	}
}

type custom_highlight = (code: string, lang: string | undefined) => string;

export function highlight_blocks({
	highlighter: highlight_fn,
	alias,
}: {
	highlighter?: custom_highlight;
	alias?: { [x: string]: string };
} = {}): MdsvexTransformer | undefined {
	if (!highlight_fn || (process as rollup_process).browser) return;

	load_language_metadata();

	if (alias) {
		for (const lang in alias) {
			langs[lang] = langs[alias[lang]];
		}
	}

	return function (tree) {
		visit<Code>(tree, 'code', (node) => {
			//@ts-ignore
			node.type = 'html';
			node.value = highlight_fn(node.value, node.lang);
		});
	};
}
// escape curlies, backtick, \t, \r, \n to avoid breaking output of {@html `here`} in .svelte
const escape_svelty = (str: string) =>
	str
		.replace(
			/[{}`]/g,
			//@ts-ignore
			(c) => ({ '{': '&#123;', '}': '&#125;', '`': '&#96;' }[c])
		)
		.replace(/\\([trn])/g, '&#92;$1');

export const code_highlight: custom_highlight = (code, lang) => {
	if ((process as rollup_process).browser) {
		let _lang = !!lang && langs[lang];

		if (!Prism) Prism = require('prismjs');

		if (_lang && !Prism.languages[_lang.name]) {
			load_language(_lang.name);
		}

		if (!_lang && lang && Prism.languages[lang]) {
			langs[lang] = { name: lang } as lang_def;
			_lang = langs[lang];
		}
		const highlighted = escape_svelty(
			_lang
				? Prism.highlight(code, Prism.languages[_lang.name], _lang.name)
				: escape(code)
		);
		return `<pre class="language-${lang}">{@html \`<code class="language-${lang}">${highlighted}</code>\`}</pre>`;
	} else {
		const highlighted = escape_svelty(escape(code));
		return `<pre class="language-${lang}">{@html \`<code class="language-${lang}">${highlighted}</code>\`}</pre>`;
	}
};
