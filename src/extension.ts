import * as vscode from "vscode";
import axios from "axios";
import OPENAI, { OpenAI } from "openai";
import { Stream } from "openai/streaming";

let VSConfig: vscode.WorkspaceConfiguration;
let apiEndpoint: string;
let apiModel: string;
let apiMessageHeader: string;
let apiTemperature: number;
let numPredict: number;
let promptWindowSize: number;
let completionKeys: string;
let responsePreview: boolean | undefined;
let responsePreviewMaxTokens: number;
let responsePreviewDelay: number;
let continueInline: boolean | undefined;
let bearerKey: string | undefined;
let client: OpenAI; 
let useOpenAiSpec: boolean;

function updateVSConfig() {
	VSConfig = vscode.workspace.getConfiguration("kb-ollama-coder");
	apiEndpoint = VSConfig.get("endpoint") || "http://localhost:11434/api/generate";
	apiModel = VSConfig.get("model") || "deepseek-coder:instruct";
	apiMessageHeader = VSConfig.get("message header") || "";
	numPredict = VSConfig.get("max tokens predicted") || 1000;
	promptWindowSize = VSConfig.get("prompt window size") || 2000;
	completionKeys = VSConfig.get("completion keys") || " ";
	responsePreview = VSConfig.get("response preview");
	responsePreviewMaxTokens = VSConfig.get("preview max tokens") || 50;
	responsePreviewDelay = VSConfig.get("preview delay") || 0; // Must be || 0 instead of || [default] because of truthy
	continueInline = VSConfig.get("continue inline");
	apiTemperature = VSConfig.get("temperature") || 0.5;
	bearerKey = VSConfig.get("bearerKey");
	client = new OpenAI({
		apiKey: VSConfig.get("apiKey"),
		baseURL: VSConfig.get("baseUrl")
	});
	useOpenAiSpec = VSConfig.get("useOpenAiSpec") || false;
}



updateVSConfig();

// No need for restart for any of these settings
vscode.workspace.onDidChangeConfiguration(updateVSConfig);

// Give model additional information
function messageHeaderSub(document: vscode.TextDocument) {
	const sub = apiMessageHeader
		.replace("{LANG}", document.languageId)
		.replace("{FILE_NAME}", document.fileName)
		.replace("{PROJECT_NAME}", vscode.workspace.name || "Untitled");
	return sub;
}

const outputChannel = vscode.window.createOutputChannel('kb-autocoder');
function log(prompt: string) {
	outputChannel.append(prompt + '\n');
	outputChannel.append(apiModel + '\n');
	outputChannel.append('useOpenAiSpec' + useOpenAiSpec + '\n');
}

// internal function for autocomplete, not directly exposed
async function autocompleteCommand(textEditor: vscode.TextEditor, cancellationToken?: vscode.CancellationToken) {
	const document = textEditor.document;
	const position = textEditor.selection.active;

	let prompt = '';

	// Add other open documents
	let others = await vscode.workspace.textDocuments;
	others = others
	.filter((other) => other !== document)
	.filter((other) => other.uri.scheme === 'file');

	others.forEach((otherDoc) => {
		if( otherDoc.uri.scheme === 'file') {
			const relativePath = vscode.workspace.asRelativePath(otherDoc.uri);
			log('FILE added to context: ' + relativePath);
			prompt += `// [FILE-NAME] ${relativePath}\n`; // Use a custom [FILE-NAME] token for new file detection
			prompt += `${otherDoc.getText()}\n\n`;
		}
	});

	// Get the current prompt
	const relativePath = vscode.workspace.asRelativePath(document.uri);
	prompt += `// [FILE-NAME] ${relativePath}\n`;
	prompt += document.getText(new vscode.Range(document.lineAt(0).range.start, position));

	// Add prompt header, Example: "You need first to write a step-by-step outline and then write the code."
	// prompt += `${messageHeaderSub(document)}\n\n}`;

	// Substring to max allowed context window length
	prompt = prompt.substring(Math.max(0, prompt.length - promptWindowSize), prompt.length);

	log(prompt);

	if (!useOpenAiSpec) {
    // Show a progress message
    apiBasedCompletion(cancellationToken, prompt, position, document, textEditor);
  } else {
		const stopCommand = ["[DONE]", "</s>", "<|EOT|>", "<|begin_of_sentence|>", "<|end_of_sentence|>", "[INST]"];
		vscode.window.withProgress(
			{
				location: vscode.ProgressLocation.Notification,
				title: "KB Autocoder",
				cancellable: true,
			},
			async (progress, progressCancellationToken) => {
				//tracker
				let currentPosition = position;
				try {
					const stream = await client.completions.create({
						stream: true,
						n: 1,
						best_of: 1,
						model: apiModel,
						prompt: prompt,
						stop: stopCommand,
						temperature: apiTemperature,
						max_tokens: numPredict, 
						frequency_penalty: 0,
						top_p: apiTemperature,
					});
					cancellationToken?.onCancellationRequested(() => {
						stream.controller.abort();
					});
					progressCancellationToken.onCancellationRequested(() => {
						stream.controller.abort();
					});
					for await(const part of stream) {
						const completion = part.choices[0]?.text;
						// outputChannel.append("COMPLETION: ");
						// outputChannel.append(completion + '\n');
						// lastToken = completion;
						if (stopCommand.includes(completion)) {
							return;
						}

						//complete edit for token
						const edit = new vscode.WorkspaceEdit();
						edit.insert(document.uri, currentPosition, completion);
						await vscode.workspace.applyEdit(edit);

						// Move the cursor to the end of the completion
						const completionLines = completion.split("\n");
						const newPosition = new vscode.Position(
							currentPosition.line + completionLines.length - 1,
							(completionLines.length > 1 ? 0 : currentPosition.character) +
							completionLines[completionLines.length - 1].length
						);
						const newSelection = new vscode.Selection(position, newPosition);
						currentPosition = newPosition;

						// completion bar
						progress.report({
							message: "Generating...",
							increment: 1 / (numPredict / 100),
						});

						// move cursor
						textEditor.selection = newSelection;
					}
				} catch(e) {
					console.error(e);
				}
			}
		);
	}
}

function apiBasedCompletion(cancellationToken: vscode.CancellationToken | undefined, prompt: string, position: vscode.Position, document: vscode.TextDocument, textEditor: vscode.TextEditor) {
	vscode.window.withProgress(
		{
			location: vscode.ProgressLocation.Notification,
			title: "KB Autocoder",
			cancellable: true,
		},
		async (progress, progressCancellationToken) => {
			try {
				progress.report({ message: "Sending to autcoder..." });

				let axiosCancelPost: () => void;
				const axiosCancelToken = new axios.CancelToken((c) => {
					const cancelPost = function () {
						c("Autocompletion request terminated by user cancel");
					};
					axiosCancelPost = cancelPost;
					if (cancellationToken)
						cancellationToken.onCancellationRequested(cancelPost);
					progressCancellationToken.onCancellationRequested(cancelPost);
					vscode.workspace.onDidCloseTextDocument(cancelPost);
				});

				// Make a request to the ollama.ai REST API
				const stopCommands = ["```", "[DONE]", "</s>", "<|EOL|>"];
				const response = await axios.post(
					apiEndpoint,
					{
						model: apiModel, // Change this to the model you want to use
						prompt: prompt,
						stream: true,
						raw: true,
						options: {
							num_predict: numPredict,
							temperature: apiTemperature,
							stop: stopCommands,
						},
					},
					{
						headers: {
							Authorization: `Bearer ${bearerKey}`,
							"Content-Type": "application/json",
						},
						cancelToken: axiosCancelToken,
						responseType: "stream",
					}
				);

				//tracker
				let currentPosition = position;

				response.data.on("data", async (d: Uint8Array) => {
          progress.report({ message: "Generating..." });

          // Get a completion from the response
          const completion: string = JSON.parse(d.toString()).response;

          // outputChannel.append("completion response: " + d.toString() + "\n");
          // lastToken = completion;
          if (stopCommands.includes(completion)) {
            axiosCancelPost();
            return;
          }

          //complete edit for token
          const edit = new vscode.WorkspaceEdit();
          edit.insert(document.uri, currentPosition, completion);
          await vscode.workspace.applyEdit(edit);

          // Move the cursor to the end of the completion
          const completionLines = completion.split("\n");
          const newPosition = new vscode.Position(
            currentPosition.line + completionLines.length - 1,
            (completionLines.length > 1 ? 0 : currentPosition.character) +
              completionLines[completionLines.length - 1].length
          );
          const newSelection = new vscode.Selection(position, newPosition);
          currentPosition = newPosition;

          // completion bar
          progress.report({
            message: "Generating...",
            increment: 1 / (numPredict / 100),
          });

          // move cursor
          textEditor.selection = newSelection;
        });

				// Keep cancel window available
				const finished = new Promise((resolve) => {
					response.data.on("end", () => {
						progress.report({ message: "Autocoder completion finished." });
						resolve(true);
					});
					axiosCancelToken.promise.finally(() => {
						// prevent notification from freezing on user input cancel
						resolve(false);
					});
				});

				await finished;
			} catch (err: any) {
				// Show an error message
				vscode.window.showErrorMessage(
					"Autocoder encountered an error: " + err.message
				);
				outputChannel.append(err.message);
			}
		}
	);
}

// Completion item provider callback for activate
async function provideCompletionItems(document: vscode.TextDocument, position: vscode.Position, cancellationToken: vscode.CancellationToken) {

	// Create a completion item
	const item = new vscode.CompletionItem("Autocomplete with Ollama");

	// Set the insert text to a placeholder
	item.insertText = new vscode.SnippetString('${1:}');

	// Wait before initializing Ollama to reduce compute usage
	if (responsePreview) await new Promise(resolve => setTimeout(resolve, responsePreviewDelay * 1000));
	if (cancellationToken.isCancellationRequested) {
		return [ item ];
	}

	// Set the label & inset text to a shortened, non-stream response
	if (responsePreview) {
		let prompt = document.getText(new vscode.Range(document.lineAt(0).range.start, position));
		prompt = prompt.substring(Math.max(0, prompt.length - promptWindowSize), prompt.length);
		const response_preview = await axios.post(apiEndpoint, {
			model: apiModel, // Change this to the model you want to use
			prompt: messageHeaderSub(document) + prompt,
			stream: false,
			raw: true,
			options: {
				num_predict: responsePreviewMaxTokens, // reduced compute max
				temperature: apiTemperature,
				stop: ['\n', '```']
			}
		}, {
			headers: {
				Authorization: `Bearer ${bearerKey}`,
			},
			cancelToken: new axios.CancelToken((c) => {
				const cancelPost = function () {
					c("Autocompletion request terminated by completion cancel");
				};
				cancellationToken.onCancellationRequested(cancelPost);
			})
		});

		if (response_preview.data.response.trim() != "") { // default if empty
			item.label = response_preview.data.response.trimStart(); // tended to add whitespace at the beginning
			item.insertText = response_preview.data.response.trimStart();
		}
	}

	// Set the documentation to a message
	item.documentation = new vscode.MarkdownString('Press `Enter` to get an autocompletion from Ollama');
	// Set the command to trigger the completion
	if (continueInline || !responsePreview) item.command = {
		command: 'kb-ollama-coder.autocomplete',
		title: 'Autocomplete with Ollama',
		arguments: [cancellationToken]
	};
	// Return the completion item
	return [item];
}

// This method is called when extension is activated
function activate(context: vscode.ExtensionContext) {
	// Register a completion provider for JavaScript files
	// const completionProvider = vscode.languages.registerCompletionItemProvider("*", {
	// 	provideCompletionItems
	// },
	// 	...completionKeys.split("")
	// );

	// Register a command for getting a completion from Ollama through command/keybind
	const externalAutocompleteCommand = vscode.commands.registerTextEditorCommand(
		"kb-ollama-coder.autocomplete",
		(textEditor, _, cancellationToken?) => {
			// no cancellation token from here, but there is one from completionProvider
			autocompleteCommand(textEditor, cancellationToken);
		}
	);

	// Add the commands & completion provider to the context
	// context.subscriptions.push(completionProvider);
	context.subscriptions.push(externalAutocompleteCommand);
}

// This method is called when extension is deactivated
function deactivate() { }

module.exports = {
	activate,
	deactivate,
};
function parseApiData(d: Uint8Array): string {
	return JSON.parse(d.toString()).response;
}

