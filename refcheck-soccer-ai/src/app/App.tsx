import { useRef, useState } from 'react';

type Verdict = 'Fair Call' | 'Bad Call' | 'Inconclusive';
type DemoClip = 'handball' | 'offside' | 'foul' | '';
type Screen = 'login' | 'dashboard' | 'analysis' | 'history';

interface RuleReference {
  law: string;
  description: string;
}

interface FrameSample {
  index: number;
  time: number;
  dataUrl: string;
}

interface AnalysisResult {
  verdict: Verdict;
  confidence: 'High' | 'Medium' | 'Low';
  decision: string;
  mode: string;
  observedPlay: string;
  reasoning: string;
  relevantRules: RuleReference[];
  timeline?: string[];
  frameCount?: number;
  timestamp?: string;
  clipName?: string;
}

const SOCCER_RULEBOOK = `
Soccer-only RefCheck rule context. Use IFAB/FIFA Laws of the Game principles.

Law 5 - The Referee:
The referee makes decisions based on the Laws of the Game and the referee's opinion from the facts of play. Video evidence can be inconclusive if the key moment, contact point, offside line, or ball position is not visible.

Law 11 - Offside:
A player is in an offside position if any part of the head, body, or feet is nearer to the opponents' goal line than both the ball and the second-last opponent. Hands and arms are not considered. Being in an offside position is not an offense by itself. The player is penalized only if, when the ball is played or touched by a teammate, the player becomes involved in active play by interfering with play, interfering with an opponent, or gaining an advantage.

Law 12 - Direct free kick fouls:
A direct free kick is awarded if a player carelessly, recklessly, or with excessive force kicks, trips, jumps at, charges, strikes, pushes, tackles, or challenges an opponent. A careless challenge is a foul but no card is required. Reckless means disregard for danger and is cautionable. Excessive force endangers safety and is a sending-off offense.

Law 12 - Handball:
It is an offense if a player deliberately touches the ball with the hand/arm, for example by moving the hand/arm toward the ball, or touches the ball with a hand/arm that has made the body unnaturally bigger. Not every ball-to-arm contact is an offense. Consider distance, deflection, expected body movement, and whether the arm position is justified by the player's action.

Law 12 - Penalty kick:
If a defending player commits a direct free kick offense inside their own penalty area, a penalty kick is awarded.

Law 12 - Cards:
Consider yellow or red card language only when the visual evidence supports careless, reckless, excessive force, stopping a promising attack, denying an obvious goal-scoring opportunity, or deliberate handball stopping a goal or promising attack.
`;

const demoResults: Record<Exclude<DemoClip, ''>, AnalysisResult> = {
  handball: {
    verdict: 'Bad Call',
    confidence: 'High',
    decision: 'Handball',
    mode: 'Demo Mode',
    observedPlay:
      'A defender raises an arm away from the body and the ball appears to strike that arm while traveling toward goal.',
    reasoning:
      'Because the arm makes the defender bigger and the contact affects a promising attack, Law 12 supports a handball offense. If the referee allowed play to continue, the better decision would be to stop play and award the correct restart.',
    relevantRules: [
      {
        law: 'Law 12 - Handball',
        description:
          'A hand/arm position that makes the body unnaturally bigger can make ball contact an offense.',
      },
      {
        law: 'Law 12 - Penalty kick',
        description:
          'A direct free kick offense by a defender inside the penalty area is punished with a penalty kick.',
      },
    ],
    timeline: ['Ball is struck toward goal.', 'Defender turns and raises the arm.', 'Ball contacts the extended arm.'],
  },
  offside: {
    verdict: 'Fair Call',
    confidence: 'Medium',
    decision: 'Offside',
    mode: 'Demo Mode',
    observedPlay:
      'The attacker appears beyond the second-last defender when the pass is played, then receives the ball and becomes involved in active play.',
    reasoning:
      'Law 11 requires the offside position to be judged at the moment the teammate plays the ball. The attacker then interferes with play by receiving the pass, so the offside call is supportable.',
    relevantRules: [
      {
        law: 'Law 11 - Offside position',
        description:
          'Head, body, or feet nearer to the goal line than both the ball and second-last opponent can create an offside position.',
      },
      {
        law: 'Law 11 - Active play',
        description:
          'A player in an offside position is penalized only when involved in active play.',
      },
    ],
    timeline: ['Pass is played.', 'Attacker is ahead of the defensive line.', 'Attacker receives the ball.'],
  },
  foul: {
    verdict: 'Fair Call',
    confidence: 'High',
    decision: 'Trip / careless challenge',
    mode: 'Demo Mode',
    observedPlay:
      'A defender challenges from behind and clips the attacker before clearly playing the ball.',
    reasoning:
      'Law 12 supports a foul when a player trips or challenges an opponent carelessly. The contact disrupts the attacker and the defender does not clearly win the ball first.',
    relevantRules: [
      {
        law: 'Law 12 - Direct free kick',
        description:
          'Tripping or carelessly challenging an opponent is punished with a direct free kick.',
      },
    ],
    timeline: ['Attacker carries the ball.', 'Defender challenges from behind.', 'Contact clips the attacker.'],
  },
};

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max);

function extractTextFromResponse(data: any): string {
  if (typeof data.output_text === 'string') return data.output_text;

  const chunks: string[] = [];
  for (const item of data.output ?? []) {
    for (const content of item.content ?? []) {
      if (typeof content.text === 'string') chunks.push(content.text);
      if (typeof content.output_text === 'string') chunks.push(content.output_text);
    }
  }
  return chunks.join('\\n').trim();
}

function parseJsonObject(text: string): any {
  const cleaned = text.replace(/```json|```/g, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start === -1 || end === -1) throw new Error('The model did not return JSON.');
  return JSON.parse(cleaned.slice(start, end + 1));
}

function getFrameTimes(duration: number, incidentSecond?: number): number[] {
  const safeDuration = Math.max(duration, 0.1);

  // If incident time is known, do a two-zone sample:
  // dense frames around the incident + sparse coverage of the full clip
  if (Number.isFinite(incidentSecond)) {
    const center = clamp(incidentSecond ?? safeDuration / 2, 0, safeDuration);

    // Dense: 8 frames within ±1.5s of the incident at ~0.2s intervals
    const dense = [-1.4, -1.0, -0.6, -0.3, -0.05, 0.2, 0.6, 1.2]
      .map((offset) => clamp(center + offset, 0, safeDuration));

    // Sparse: 1 frame per second across the full clip for context
    const contextCount = Math.min(Math.floor(safeDuration), 6);
    const sparse = Array.from({ length: contextCount }, (_, i) =>
      clamp((safeDuration / (contextCount + 1)) * (i + 1), 0, safeDuration)
    );

    // Merge, deduplicate times closer than 0.1s, sort
    return [...dense, ...sparse]
      .sort((a, b) => a - b)
      .filter((time, i, arr) => i === 0 || time - arr[i - 1] > 0.1);
  }

  // No incident time: 1 frame every 0.5s up to 20 frames max
  const interval = 0.1;
  const count = Math.min(Math.floor(safeDuration / interval), 10);
  return Array.from({ length: count }, (_, i) =>
    clamp(interval * i + interval / 2, 0, safeDuration)
  );
}

async function extractVideoFrames(videoFile: File, incidentSecond?: number): Promise<FrameSample[]> {
  const url = URL.createObjectURL(videoFile);
  const video = document.createElement('video');
  video.preload = 'metadata';
  video.muted = true;
  video.playsInline = true;
  video.src = url;

  try {
    await new Promise<void>((resolve, reject) => {
      video.onloadedmetadata = () => resolve();
      video.onerror = () => reject(new Error('Unable to read this video file.'));
    });

    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas is not available in this browser.');

    const scale = Math.min(1, 768 / Math.max(video.videoWidth, video.videoHeight));
    canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
    canvas.height = Math.max(1, Math.round(video.videoHeight * scale));

    const samples: FrameSample[] = [];
    for (const [index, time] of getFrameTimes(video.duration, incidentSecond).entries()) {
      await new Promise<void>((resolve, reject) => {
        const timeout = window.setTimeout(() => reject(new Error('Timed out while extracting frames.')), 7000);
        video.onseeked = () => {
          window.clearTimeout(timeout);
          resolve();
        };
        video.currentTime = time;
      });

      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      samples.push({ index: index + 1, time, dataUrl: canvas.toDataURL('image/jpeg', 0.82) });
    }
    return samples;
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function callOpenAI(input: Array<Record<string, unknown>>, temperature: number): Promise<string> {
  const model = (import.meta as any).env.VITE_OPENAI_MODEL || 'gpt-4o';
  const response = await fetch('/api/openai/v1/responses', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      temperature,
      max_output_tokens: 1400,
      input: [{ role: 'user', content: input }],
    }),
  });

  if (!response.ok) {
    let detail = response.statusText;
    try {
      const err = await response.json();
      detail = err.error?.message || detail;
    } catch {
      detail = await response.text();
    }
    throw new Error(`OpenAI API error: ${detail}`);
  }

  const data = await response.json();
  const text = extractTextFromResponse(data);
  if (!text) throw new Error('OpenAI returned an empty response.');
  return text;
}

async function describeFrames(
  frames: FrameSample[],
  refCall: string,
  notes: string
): Promise<string> {
  const prompt = `You are an expert soccer video analyst assisting a VAR (Video Assistant Referee) review. You are given ${frames.length} sequential JPEG frames extracted from a single soccer clip.

Frame timestamps: ${frames.map((frame) => `Frame ${frame.index} at ${frame.time.toFixed(2)}s`).join(', ')}
Referee's original call: ${refCall || 'Not specified'}
Reviewer notes: ${notes || 'None'}

Analyze each frame in order and produce a precise, structured description. For each frame, note what has changed from the previous one. Then provide an overall summary.

Cover every observable detail relevant to officiating:

BALL: exact location in each frame, trajectory direction, whether it has been played/touched, moment of contact if visible.

PLAYERS: jersey colors, numbers if visible, body orientation, foot/leg position at moment of challenge, arm position relative to torso (natural vs. unnatural), whether any player is airborne.

OFFSIDE CHECK: identify the second-last defender's position. Note whether an attacker's head, torso, or feet are ahead of that line at the moment the ball is played. State clearly if the pass moment is NOT visible.

CONTACT: describe the exact body part that initiates contact, the direction of force, whether the ball is played before the player, and whether the contact is from behind, side, or front.

KEY DECISION MOMENT: explicitly state which frame contains the decisive moment (or that it is not captured). If the key frame is blurry or obscured, say so.

DO NOT give a verdict or cite laws. Be precise, clinical, and objective — like a VAR operator narrating a replay to a referee.`;
  return callOpenAI(
    [
      { type: 'input_text', text: prompt },
      ...frames.map((frame) => ({
        type: 'input_image',
        image_url: frame.dataUrl,
        detail: 'low',
      })),
    ],
    0.2
  );
}

async function getSoccerVerdict(playDescription: string, refCall: string, notes: string): Promise<AnalysisResult> {
  const prompt = `You are RefCheck AI, a soccer-only officiating assistant.

RULEBOOK CONTEXT:
${SOCCER_RULEBOOK}

REFEREE'S ORIGINAL CALL:
${refCall || 'Not specified'}

REVIEWER NOTES:
${notes || 'None'}

NEUTRAL FRAME DESCRIPTION:
${playDescription}

Return ONLY a valid JSON object with this exact schema:
{
  "verdict": "Fair Call",
  "confidence": "High",
  "decision": "Handball / Offside / Foul / No offense / Inconclusive",
  "observedPlay": "One or two sentences about what is visible.",
  "reasoning": "Two or three sentences comparing the visible facts to the law. Mention uncertainty when a key moment is not visible.",
  "timeline": ["Frame-by-frame key observation", "Another key observation"],
  "relevantRules": [
    { "law": "Law 12 - Handball", "description": "Specific rule principle that applies." }
  ]
}

verdict must be exactly one of "Fair Call", "Bad Call", or "Inconclusive".
confidence must be exactly one of "High", "Medium", or "Low".
Use Inconclusive if the frames do not show the decisive contact, pass moment, offside line, or ball position clearly enough.`;

  const text = await callOpenAI([{ type: 'input_text', text: prompt }], 0.1);
  const parsed = parseJsonObject(text);

  return {
    verdict: parsed.verdict ?? 'Inconclusive',
    confidence: parsed.confidence ?? 'Low',
    decision: parsed.decision ?? 'Inconclusive',
    mode: `${(import.meta as any).env.VITE_OPENAI_MODEL || 'gpt-4o'} multi-frame`,
    observedPlay: parsed.observedPlay ?? '',
    reasoning: parsed.reasoning ?? '',
    timeline: Array.isArray(parsed.timeline) ? parsed.timeline : [],
    relevantRules: Array.isArray(parsed.relevantRules) ? parsed.relevantRules : [],
  };
}

async function runAnalysisPipeline(
  videoFile: File | null,
  demoClip: DemoClip,
  refCall: string,
  notes: string,
  incidentSecond: string,
  onStatus: (msg: string) => void
): Promise<AnalysisResult> {
  if (!videoFile && demoClip) {
    onStatus('Loading soccer demo result...');
    await new Promise((resolve) => setTimeout(resolve, 700));
    return { ...demoResults[demoClip] };
  }

  if (!videoFile) throw new Error('No video file provided.');

  const parsedIncident = incidentSecond.trim() ? Number(incidentSecond) : undefined;
  if (parsedIncident !== undefined && !Number.isFinite(parsedIncident)) {
    throw new Error('Incident time must be a number of seconds, like 4 or 4.5.');
  }

  onStatus('Step 1 of 3 - extracting key frames in your browser...');
  const frames = await extractVideoFrames(videoFile, parsedIncident);

  onStatus(`Step 2 of 3 - GPT-4o is reading ${frames.length} sequential frames...`);
  const playDescription = await describeFrames(frames, refCall, notes);

  onStatus('Step 3 of 3 - comparing the play to soccer laws...');
  const result = await getSoccerVerdict(playDescription, refCall, notes);

  return { ...result, frameCount: frames.length };
}

export default function App() {
  const [currentScreen, setCurrentScreen] = useState<Screen>('login');
  const [username, setUsername] = useState('');
  const [refCall, setRefCall] = useState('');
  const [incidentSecond, setIncidentSecond] = useState('');
  const [demoClip, setDemoClip] = useState<DemoClip>('');
  const [notes, setNotes] = useState('');
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [statusMsg, setStatusMsg] = useState('');
  const [result, setResult] = useState<AnalysisResult | null>(null);
  const [analysisHistory, setAnalysisHistory] = useState<AnalysisResult[]>([]);
  const [uploadedVideo, setUploadedVideo] = useState<string | null>(null);
  const [videoFile, setVideoFile] = useState<File | null>(null);
  const [videoFileName, setVideoFileName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleLogin = (e: React.FormEvent) => {
    e.preventDefault();
    if (username.trim()) setCurrentScreen('dashboard');
  };

  const handleLogout = () => {
    setCurrentScreen('login');
    setUsername('');
  };

  const handleVideoUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file && file.type.startsWith('video/')) {
      if (uploadedVideo) URL.revokeObjectURL(uploadedVideo);
      setUploadedVideo(URL.createObjectURL(file));
      setVideoFile(file);
      setVideoFileName(file.name);
      setDemoClip('');
      setResult(null);
      setError(null);
    }
  };

  const handleDemoChange = (value: DemoClip) => {
    setDemoClip(value);
    if (value) {
      if (uploadedVideo) URL.revokeObjectURL(uploadedVideo);
      setUploadedVideo(null);
      setVideoFile(null);
      setVideoFileName('');
      setResult(null);
      setError(null);
    }
  };

  const handleAnalyze = async () => {
    if (!demoClip && !videoFile) return;
    setIsAnalyzing(true);
    setResult(null);
    setError(null);
    setStatusMsg('Starting soccer analysis...');

    try {
      const clipNames: Record<string, string> = {
        handball: 'Handball demo',
        offside: 'Offside demo',
        foul: 'Foul demo',
      };

      const analysisResult = await runAnalysisPipeline(videoFile, demoClip, refCall, notes, incidentSecond, setStatusMsg);
      analysisResult.timestamp = new Date().toLocaleString();
      analysisResult.clipName = videoFile ? videoFileName : demoClip ? clipNames[demoClip] : 'Unknown';

      setResult(analysisResult);
      setAnalysisHistory((prev) => [analysisResult, ...prev]);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsAnalyzing(false);
      setStatusMsg('');
    }
  };

  const verdictColor = (v: Verdict) =>
    v === 'Fair Call' ? 'bg-green-600' : v === 'Bad Call' ? 'bg-red-600' : 'bg-yellow-500 text-black';

  if (currentScreen === 'login') {
    return (
      <div className="size-full bg-[#f4f0ea] flex items-center justify-center p-6">
        <div className="bg-white rounded-lg shadow-xl p-8 w-full max-w-md border-2 border-black">
          <div className="text-center mb-8">
            <div className="bg-green-600 w-16 h-16 rounded-lg mx-auto mb-4 flex items-center justify-center border-2 border-black">
              <span className="text-white text-3xl">✓</span>
            </div>
            <h1 className="text-gray-950 mb-2">RefCheck AI</h1>
            <p className="text-gray-600">Soccer officiating analysis from video frames</p>
          </div>
          <form onSubmit={handleLogin} className="space-y-4">
            <div>
              <label className="block text-gray-700 mb-2">Username</label>
              <input type="text" value={username} onChange={(e) => setUsername(e.target.value)} placeholder="Enter your username"
                className="w-full px-4 py-3 bg-gray-50 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-green-500" required />
            </div>
            <div>
              <label className="block text-gray-700 mb-2">Password</label>
              <input type="password" placeholder="Enter your password"
                className="w-full px-4 py-3 bg-gray-50 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-green-500" required />
            </div>
            <button type="submit" className="w-full bg-green-600 hover:bg-green-700 text-white py-3 px-6 rounded-lg transition-colors shadow-sm">
              Sign In
            </button>
          </form>
          <p className="mt-6 text-center text-sm text-gray-500">Demo credentials: any username/password</p>
        </div>
      </div>
    );
  }

  if (currentScreen === 'dashboard') {
    return (
      <div className="size-full bg-gray-50 flex flex-col">
        <header className="bg-white border-b border-gray-200 px-8 py-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="bg-green-600 w-10 h-10 rounded-lg flex items-center justify-center text-white border border-black">✓</div>
              <div>
                <h1 className="text-gray-900">RefCheck AI</h1>
                <p className="text-xs text-gray-500">Soccer-only frame review</p>
              </div>
            </div>
            <div className="flex items-center gap-4">
              <span className="text-gray-600">Welcome, {username}</span>
              <button onClick={handleLogout} className="text-gray-600 hover:text-gray-900 transition-colors">Logout</button>
            </div>
          </div>
        </header>

        <div className="flex-1 p-8 overflow-y-auto">
          <div className="max-w-6xl mx-auto">
            <div className="mb-8">
              <h2 className="text-gray-900 mb-2">Dashboard</h2>
              <p className="text-gray-600">Upload short soccer clips, extract key frames, and compare the play to Laws 11 and 12.</p>
            </div>

            <div className="bg-white border-2 border-black rounded-lg p-5 mb-8 shadow-[6px_6px_0_#111]">
              <p className="text-sm font-semibold text-gray-700 mb-3">OpenAI pipeline</p>
              <div className="flex items-center gap-2 flex-wrap text-sm">
                <span className="bg-blue-100 text-blue-900 px-3 py-1 rounded-md font-medium">Upload clip</span>
                <span className="text-gray-400">→</span>
                <span className="bg-yellow-100 text-yellow-900 px-3 py-1 rounded-md font-medium">Extract 5-6 frames</span>
                <span className="text-gray-400">→</span>
                <span className="bg-purple-100 text-purple-900 px-3 py-1 rounded-md font-medium">GPT-4o describes timeline</span>
                <span className="text-gray-400">→</span>
                <span className="bg-green-100 text-green-900 px-3 py-1 rounded-md font-medium">Soccer verdict JSON</span>
              </div>
            </div>

            <div className="grid grid-cols-3 gap-6 mb-8">
              {[
                { label: 'Total Reviews', count: analysisHistory.length, color: 'text-green-600' },
                { label: 'Fair Calls', count: analysisHistory.filter((a) => a.verdict === 'Fair Call').length, color: 'text-green-600' },
                { label: 'Bad Calls', count: analysisHistory.filter((a) => a.verdict === 'Bad Call').length, color: 'text-red-600' },
              ].map((stat) => (
                <div key={stat.label} className="bg-white rounded-lg shadow-sm p-6 border border-gray-100">
                  <p className="text-gray-600 mb-2">{stat.label}</p>
                  <p className={`text-4xl ${stat.color}`}>{stat.count}</p>
                </div>
              ))}
            </div>

            <div className="bg-white rounded-lg shadow-sm p-8 mb-8">
              <h3 className="text-gray-900 mb-6">Quick Actions</h3>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <button onClick={() => setCurrentScreen('analysis')} className="bg-green-600 hover:bg-green-700 text-white p-6 rounded-lg transition-colors text-left">
                  <h4 className="mb-1">New Soccer Analysis</h4>
                  <p className="text-sm text-green-100">Upload a clip or run a demo</p>
                </button>
                <button onClick={() => setCurrentScreen('history')} className="bg-blue-600 hover:bg-blue-700 text-white p-6 rounded-lg transition-colors text-left">
                  <h4 className="mb-1">View History</h4>
                  <p className="text-sm text-blue-100">Review past verdicts</p>
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (currentScreen === 'history') {
    return (
      <div className="size-full bg-gray-50 flex flex-col">
        <header className="bg-white border-b border-gray-200 px-8 py-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-6">
              <button onClick={() => setCurrentScreen('dashboard')} className="text-gray-600 hover:text-gray-900">Back</button>
              <h1 className="text-gray-900">Analysis History</h1>
            </div>
            <button onClick={handleLogout} className="text-gray-600 hover:text-gray-900">Logout</button>
          </div>
        </header>
        <div className="flex-1 p-8 overflow-y-auto">
          <div className="max-w-4xl mx-auto">
            {analysisHistory.length === 0 ? (
              <div className="text-center py-12">
                <p className="text-gray-600 mb-4">No analysis history yet</p>
                <button onClick={() => setCurrentScreen('analysis')} className="bg-green-600 hover:bg-green-700 text-white py-2 px-6 rounded-lg">
                  Start First Analysis
                </button>
              </div>
            ) : (
              <div className="space-y-6">
                {analysisHistory.map((item, i) => (
                  <div key={i} className="bg-white rounded-lg shadow-sm p-6">
                    <div className="flex items-start justify-between mb-4">
                      <div>
                        <h3 className="text-gray-900 mb-1">{item.clipName}</h3>
                        <p className="text-sm text-gray-500">{item.timestamp}</p>
                      </div>
                      <span className={`${verdictColor(item.verdict)} px-4 py-1 rounded-full text-white`}>{item.verdict}</span>
                    </div>
                    <div className="grid grid-cols-3 gap-4 mb-4 text-sm">
                      <div><p className="text-gray-500">Decision</p><p className="text-gray-900">{item.decision}</p></div>
                      <div><p className="text-gray-500">Confidence</p><p className="text-gray-900">{item.confidence}</p></div>
                      <div><p className="text-gray-500">Frames</p><p className="text-gray-900">{item.frameCount ?? 'Demo'}</p></div>
                    </div>
                    <p className="text-sm text-gray-700">{item.reasoning}</p>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="size-full bg-gray-50 flex flex-col">
      <header className="bg-white border-b border-gray-200 px-8 py-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-6">
            <button onClick={() => setCurrentScreen('dashboard')} className="text-gray-600 hover:text-gray-900">Back</button>
            <h1 className="text-gray-900">New Soccer Analysis</h1>
          </div>
          <button onClick={handleLogout} className="text-gray-600 hover:text-gray-900">Logout</button>
        </div>
      </header>

      <div className="flex-1 flex flex-col lg:flex-row min-h-0">
        <div className="w-full lg:w-1/2 p-8 bg-white border-r border-gray-200 overflow-y-auto">
          <div className="max-w-xl mx-auto space-y-6">
            <div>
              <h2 className="text-gray-900 mb-1">Clip Review</h2>
              <p className="text-gray-600 text-sm">Best with soccer clips under 10 seconds. Add the incident second if you know it.</p>
            </div>

            <div className="bg-green-50 border border-green-200 rounded-lg p-3 text-sm text-green-900">
              Sport locked to <strong>Soccer</strong>. Rule context focuses on offside, handball, fouls, penalties, and card severity.
            </div>

            <div>
              <label className="block text-gray-700 mb-2">Original referee call</label>
              <input type="text" value={refCall} onChange={(e) => setRefCall(e.target.value)} placeholder="e.g., No handball, offside, penalty awarded"
                className="w-full px-4 py-2 bg-gray-50 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-green-500" />
            </div>

            <div>
              <label className="block text-gray-700 mb-2">Incident time in seconds (optional)</label>
              <input type="text" value={incidentSecond} onChange={(e) => setIncidentSecond(e.target.value)} placeholder="e.g., 4.2"
                className="w-full px-4 py-2 bg-gray-50 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-green-500" />
              <p className="text-xs text-gray-500 mt-1">When provided, frames are sampled tightly around that moment.</p>
            </div>

            <div>
              <label className="block text-gray-700 mb-2">Upload soccer video clip</label>
              <input ref={fileInputRef} type="file" accept="video/*" onChange={handleVideoUpload} className="hidden" id="video-upload" />
              <label htmlFor="video-upload"
                className="block border-2 border-dashed border-gray-300 rounded-lg p-8 text-center bg-gray-50 hover:bg-gray-100 transition-colors cursor-pointer">
                {uploadedVideo ? (
                  <div className="space-y-2">
                    <p className="text-gray-900 font-medium">{videoFileName}</p>
                    <p className="text-xs text-green-600">Ready for browser frame extraction</p>
                    <video src={uploadedVideo} controls className="w-full rounded-lg mt-2" style={{ maxHeight: '180px' }} />
                  </div>
                ) : (
                  <>
                    <p className="text-gray-600">Click to choose a video file</p>
                    <p className="text-sm text-gray-500 mt-1">MP4, MOV, WebM, and browser-supported video files</p>
                  </>
                )}
              </label>
            </div>

            <div>
              <label className="block text-gray-700 mb-2">Or select demo clip</label>
              <select value={demoClip} onChange={(e) => handleDemoChange(e.target.value as DemoClip)}
                className="w-full px-4 py-2 bg-gray-50 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-green-500">
                <option value="">Choose a demo...</option>
                <option value="handball">Handball</option>
                <option value="offside">Offside</option>
                <option value="foul">Foul</option>
              </select>
            </div>

            <div>
              <label className="block text-gray-700 mb-2">Reviewer notes (optional)</label>
              <textarea value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="e.g., possible handball at 0:04, attacker in blue may be offside"
                rows={3} className="w-full px-4 py-2 bg-gray-50 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-green-500 resize-none" />
            </div>

            {videoFile && (
              <div className="bg-blue-50 border border-blue-200 rounded-lg p-3 text-xs text-blue-800">
                Live AI mode uses your local <code>OPENAI_API_KEY</code> through the Vite proxy. The app sends extracted JPEG frames, not the full video.
              </div>
            )}

            <button onClick={handleAnalyze} disabled={(!demoClip && !videoFile) || isAnalyzing}
              className="w-full bg-green-600 hover:bg-green-700 text-white py-3 px-6 rounded-lg disabled:bg-gray-300 disabled:cursor-not-allowed transition-colors shadow-sm">
              {isAnalyzing ? (statusMsg || 'Analyzing...') : 'Analyze Soccer Clip'}
            </button>
          </div>
        </div>

        <div className="w-full lg:w-1/2 p-8 overflow-y-auto bg-gray-50">
          <div className="max-w-2xl mx-auto">
            {error && (
              <div className="bg-red-50 border border-red-200 rounded-lg p-6 mb-6">
                <h3 className="text-red-800 font-semibold mb-2">Analysis Error</h3>
                <p className="text-red-700 text-sm font-mono break-words">{error}</p>
                <p className="text-red-600 text-xs mt-2">
                  For live video, set <code>OPENAI_API_KEY</code> in <code>.env</code>. Demo clips work without API calls.
                </p>
              </div>
            )}

            {!result && !isAnalyzing && !error && (
              <div className="flex items-center justify-center h-full min-h-64">
                <div className="text-center text-gray-400">
                  <p>Select a soccer clip and click Analyze to see results</p>
                </div>
              </div>
            )}

            {isAnalyzing && (
              <div className="flex flex-col items-center justify-center min-h-64">
                <div className="animate-spin rounded-full h-14 w-14 border-b-2 border-green-600 mb-4"></div>
                <p className="text-gray-600 text-center max-w-xs mb-4">{statusMsg || 'Analyzing...'}</p>
                {videoFile && (
                  <div className="flex items-center gap-2 text-xs text-gray-500">
                    <span className="bg-yellow-100 text-yellow-800 px-2 py-1 rounded-full">Frames</span>
                    <span>→</span>
                    <span className="bg-purple-100 text-purple-800 px-2 py-1 rounded-full">GPT-4o vision</span>
                    <span>→</span>
                    <span className="bg-green-100 text-green-800 px-2 py-1 rounded-full">Soccer laws</span>
                  </div>
                )}
              </div>
            )}

            {result && (
              <div className="space-y-6">
                {uploadedVideo && (
                  <div className="bg-white rounded-lg shadow-sm p-6">
                    <h3 className="text-gray-900 mb-3">Video Clip</h3>
                    <video src={uploadedVideo} controls className="w-full rounded-lg" />
                  </div>
                )}

                <div className="bg-white rounded-lg shadow-sm p-6">
                  <p className="text-gray-500 text-sm mb-2">Verdict</p>
                  <span className={`${verdictColor(result.verdict)} px-6 py-2 rounded-full text-lg font-semibold text-white`}>
                    {result.verdict}
                  </span>
                </div>

                <div className="grid grid-cols-3 gap-4">
                  <div className="bg-white rounded-lg shadow-sm p-4">
                    <p className="text-xs text-gray-500 mb-1">Confidence</p>
                    <p className="text-gray-900 font-medium">{result.confidence}</p>
                  </div>
                  <div className="bg-white rounded-lg shadow-sm p-4">
                    <p className="text-xs text-gray-500 mb-1">Decision</p>
                    <p className="text-gray-900 font-medium">{result.decision}</p>
                  </div>
                  <div className="bg-white rounded-lg shadow-sm p-4">
                    <p className="text-xs text-gray-500 mb-1">Frames</p>
                    <p className="text-gray-900 font-medium">{result.frameCount ?? 'Demo'}</p>
                  </div>
                </div>

                <div className="bg-white rounded-lg shadow-sm p-6">
                  <h3 className="text-gray-900 mb-3">Observed Play</h3>
                  <p className="text-gray-700 leading-relaxed">{result.observedPlay}</p>
                </div>

                <div className="bg-white rounded-lg shadow-sm p-6">
                  <h3 className="text-gray-900 mb-3">Reasoning</h3>
                  <p className="text-gray-700 leading-relaxed">{result.reasoning}</p>
                </div>

                {!!result.timeline?.length && (
                  <div className="bg-white rounded-lg shadow-sm p-6">
                    <h3 className="text-gray-900 mb-4">Timeline</h3>
                    <div className="space-y-2">
                      {result.timeline.map((item, i) => (
                        <p key={i} className="text-sm text-gray-700 border-l-4 border-green-500 pl-3">{item}</p>
                      ))}
                    </div>
                  </div>
                )}

                <div className="bg-white rounded-lg shadow-sm p-6">
                  <h3 className="text-gray-900 mb-4">Relevant Rules</h3>
                  <div className="space-y-3">
                    {result.relevantRules.map((rule, i) => (
                      <div key={i} className="border border-gray-200 rounded-lg p-4 bg-gray-50">
                        <p className="text-green-700 font-medium mb-1">{rule.law}</p>
                        <p className="text-sm text-gray-600">{rule.description}</p>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
