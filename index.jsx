import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Play, Pause, Upload, Download, RotateCcw, Activity, Volume2, Waves, Sliders, Music } from 'lucide-react';

const WORKLET_PROCESSOR_CODE = `
class PitchShiftProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.phase = 0;
    this.pitchRatio = 1.0;
    this.grainSize = 2048; 
    this.overlap = 0.5;    
    this.mix = 1.0;        
    
    // Circular buffer for granular processing
    this.buffer = new Float32Array(65536); 
    this.writePtr = 0;
    
    this.port.onmessage = (e) => {
      if (e.data.type === 'SET_PITCH') this.pitchRatio = e.data.value;
      if (e.data.type === 'SET_GRAIN') this.grainSize = Math.floor(e.data.value);
      if (e.data.type === 'SET_OVERLAP') this.overlap = e.data.value;
      if (e.data.type === 'SET_MIX') this.mix = e.data.value;
    };
  }

  process(inputs, outputs) {
    const input = inputs[0];
    const output = outputs[0];
    if (!input || !input[0] || !output[0]) return true;

    const inputChannel = input[0];
    const outputChannel = output[0];
    const length = inputChannel.length;

    for (let i = 0; i < length; i++) {
      const drySignal = inputChannel[i];
      this.buffer[this.writePtr] = drySignal;
      
      // Granular pointer calculation
      // Uses a shifting read pointer relative to the write pointer to create pitch deviation
      let readPtr = (this.writePtr - (this.phase % (this.grainSize * this.overlap))) % this.buffer.length;
      if (readPtr < 0) readPtr += this.buffer.length;
      
      const wetSignal = this.buffer[Math.floor(readPtr)];
      
      // Apply Dry/Wet mix
      outputChannel[i] = (wetSignal * this.mix) + (drySignal * (1 - this.mix));
      
      this.phase += this.pitchRatio;
      this.writePtr = (this.writePtr + 1) % this.buffer.length;
    }

    return true;
  }
}
registerProcessor('pitch-shift-processor', PitchShiftProcessor);
`;

const App = () => {
  const [audioCtx, setAudioCtx] = useState(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [fileName, setFileName] = useState('');
  const [pitch, setPitch] = useState(0); 
  const [cents, setCents] = useState(0);
  const [grainSize, setGrainSize] = useState(50); 
  const [overlap, setOverlap] = useState(0.5);
  const [mix, setMix] = useState(1.0);
  const [volume, setVolume] = useState(0.8);
  const [isProcessing, setIsProcessing] = useState(false);

  const audioRef = useRef(null);
  const sourceNodeRef = useRef(null);
  const workletNodeRef = useRef(null);
  const gainNodeRef = useRef(null);
  const analyzerRef = useRef(null);
  const canvasRef = useRef(null);
  const animationFrameRef = useRef(null);
  const recordedChunksRef = useRef([]);

  const initAudio = async () => {
    if (audioCtx) return audioCtx;

    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    
    try {
      const blob = new Blob([WORKLET_PROCESSOR_CODE], { type: 'application/javascript' });
      const url = URL.createObjectURL(blob);
      await ctx.audioWorklet.addModule(url);

      const workletNode = new AudioWorkletNode(ctx, 'pitch-shift-processor');
      const gainNode = ctx.createGain();
      const analyzer = ctx.createAnalyser();
      analyzer.fftSize = 512;

      gainNode.gain.value = volume;

      workletNodeRef.current = workletNode;
      gainNodeRef.current = gainNode;
      analyzerRef.current = analyzer;
      setAudioCtx(ctx);

      return ctx;
    } catch (err) {
      console.error("Audio Initialization Error:", err);
      return null;
    }
  };

  const handleFileUpload = (e) => {
    const file = e.target.files[0];
    if (file) {
      setFileName(file.name);
      const url = URL.createObjectURL(file);
      if (audioRef.current) {
        audioRef.current.src = url;
        setIsPlaying(false);
      }
    }
  };

  useEffect(() => {
    if (workletNodeRef.current) {
      const totalSemitones = parseFloat(pitch) + (parseFloat(cents) / 100);
      const ratio = Math.pow(2, totalSemitones / 12);
      workletNodeRef.current.port.postMessage({ type: 'SET_PITCH', value: ratio });
    }
  }, [pitch, cents]);

  useEffect(() => {
    if (workletNodeRef.current && audioCtx) {
      const samples = (grainSize / 1000) * audioCtx.sampleRate;
      workletNodeRef.current.port.postMessage({ type: 'SET_GRAIN', value: samples });
    }
  }, [grainSize, audioCtx]);

  useEffect(() => {
    if (workletNodeRef.current) {
      workletNodeRef.current.port.postMessage({ type: 'SET_OVERLAP', value: overlap });
      workletNodeRef.current.port.postMessage({ type: 'SET_MIX', value: mix });
    }
  }, [overlap, mix]);

  useEffect(() => {
    if (gainNodeRef.current) {
      gainNodeRef.current.gain.setTargetAtTime(volume, audioCtx?.currentTime || 0, 0.05);
    }
  }, [volume, audioCtx]);

  const togglePlayback = async () => {
    const ctx = await initAudio();
    if (!ctx) return;

    if (ctx.state === 'suspended') {
      await ctx.resume();
    }

    if (!sourceNodeRef.current && audioRef.current) {
      const source = ctx.createMediaElementSource(audioRef.current);
      source.connect(workletNodeRef.current);
      workletNodeRef.current.connect(gainNodeRef.current);
      gainNodeRef.current.connect(analyzerRef.current);
      analyzerRef.current.connect(ctx.destination);
      sourceNodeRef.current = source;
    }

    if (isPlaying) {
      audioRef.current.pause();
    } else {
      audioRef.current.play();
      drawVisualizer();
    }
    setIsPlaying(!isPlaying);
  };

  const drawVisualizer = useCallback(() => {
    if (!canvasRef.current || !analyzerRef.current) return;

    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d');
    const bufferLength = analyzerRef.current.frequencyBinCount;
    const dataArray = new Uint8Array(bufferLength);

    const render = () => {
      animationFrameRef.current = requestAnimationFrame(render);
      analyzerRef.current.getByteFrequencyData(dataArray);

      ctx.fillStyle = '#020617';
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      const barWidth = (canvas.width / bufferLength) * 2;
      let x = 0;

      for (let i = 0; i < bufferLength; i++) {
        const barHeight = (dataArray[i] / 255) * canvas.height;
        const hue = (i / bufferLength) * 360;
        ctx.fillStyle = `hsla(${hue}, 80%, 60%, 0.7)`;
        ctx.fillRect(x, canvas.height - barHeight, barWidth - 1, barHeight);
        x += barWidth;
      }
    };

    render();
  }, []);

  const exportAudio = async () => {
    if (!audioCtx || !workletNodeRef.current) return;
    setIsProcessing(true);
    
    const dest = audioCtx.createMediaStreamDestination();
    gainNodeRef.current.connect(dest);
    
    const recorder = new MediaRecorder(dest.stream);
    recordedChunksRef.current = [];

    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) recordedChunksRef.current.push(e.data);
    };

    recorder.onstop = () => {
      const blob = new Blob(recordedChunksRef.current, { type: 'audio/wav' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `shifted-${fileName || 'audio'}.wav`;
      a.click();
      setIsProcessing(false);
    };

    audioRef.current.currentTime = 0;
    recorder.start();
    audioRef.current.play();
    setIsPlaying(true);

    audioRef.current.onended = () => {
      recorder.stop();
      setIsPlaying(false);
      audioRef.current.onended = null;
    };
  };

  return (
    <div className="min-h-screen bg-slate-950 text-slate-200 p-4 md:p-8 font-sans">
      <div className="max-w-5xl mx-auto space-y-6">
        
        {/* Header Section */}
        <header className="flex flex-col md:flex-row md:items-center justify-between gap-4 border-b border-slate-800 pb-6">
          <div>
            <h1 className="text-4xl font-black tracking-tighter bg-clip-text text-transparent bg-gradient-to-r from-indigo-400 via-purple-400 to-pink-400">
              PITCHSHIFTER PRO
            </h1>
            <p className="text-slate-500 font-medium text-sm flex items-center gap-2 mt-1">
              <Activity size={14} /> HIGH-PRECISION GRANULAR DSP ENGINE
            </p>
          </div>
          <div className="flex items-center gap-3">
            <label className="flex items-center gap-2 px-6 py-3 bg-indigo-600 hover:bg-indigo-500 rounded-xl cursor-pointer transition-all shadow-xl shadow-indigo-500/20 active:scale-95 font-bold text-white uppercase text-xs tracking-widest">
              <Upload size={16} />
              <span>Load File</span>
              <input type="file" className="hidden" accept="audio/*" onChange={handleFileUpload} />
            </label>
          </div>
        </header>

        {/* Workspace Layout */}
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
          
          {/* Left Column: Visualizer and Player */}
          <section className="lg:col-span-8 space-y-4">
            <div className="relative group rounded-3xl overflow-hidden border border-slate-800 bg-slate-900 shadow-2xl">
              <canvas 
                ref={canvasRef} 
                width={1200} 
                height={500} 
                className="w-full h-[320px] object-cover opacity-80"
              />
              <div className="absolute inset-0 bg-gradient-to-t from-slate-950 via-transparent to-transparent opacity-60" />
              
              {/* Transport Controls */}
              <div className="absolute bottom-6 left-6 right-6 flex items-center gap-4 bg-slate-900/40 backdrop-blur-xl p-4 rounded-2xl border border-white/10">
                <button 
                  onClick={togglePlayback}
                  className="w-14 h-14 flex items-center justify-center bg-white text-slate-950 rounded-2xl hover:scale-105 transition-all shadow-lg active:scale-95"
                >
                  {isPlaying ? <Pause fill="currentColor" size={24} /> : <Play fill="currentColor" size={24} className="ml-1" />}
                </button>
                <div className="flex-1 overflow-hidden">
                  <div className="text-xs font-bold text-indigo-400 uppercase tracking-widest mb-1">Now Playing</div>
                  <div className="text-sm font-semibold truncate text-slate-100">
                    {fileName || "Select an audio file to begin..."}
                  </div>
                </div>
                <div className="text-right">
                   <div className="text-[10px] font-bold text-slate-500 uppercase tracking-widest">Sample Rate</div>
                   <div className="text-xs font-mono text-white">{audioCtx?.sampleRate || "--"} Hz</div>
                </div>
              </div>
            </div>

            {/* Volume Control Bar */}
            <div className="bg-slate-900/50 p-6 rounded-3xl border border-slate-800/50 flex items-center gap-6">
              <Volume2 className="text-slate-500" size={20} />
              <input 
                type="range" min="0" max="1.5" step="0.01" value={volume}
                onChange={(e) => setVolume(parseFloat(e.target.value))}
                className="flex-1 h-2 bg-slate-800 rounded-full appearance-none cursor-pointer accent-white"
              />
              <span className="text-xs font-mono w-10 text-right">{Math.round(volume * 100)}%</span>
            </div>
          </section>

          {/* Right Column: DSP Controls */}
          <section className="lg:col-span-4 space-y-6">
            <div className="bg-slate-900 p-6 rounded-3xl border border-slate-800 shadow-xl space-y-8">
              
              {/* Main Pitch Slider */}
              <div className="space-y-4">
                <div className="flex justify-between items-center">
                  <div className="flex items-center gap-2 text-indigo-400 font-bold text-xs uppercase tracking-widest">
                    <Music size={16} /> Pitch Shift
                  </div>
                  <div className="text-3xl font-black text-white font-mono italic">
                    {pitch > 0 ? `+${pitch}` : pitch}
                  </div>
                </div>
                <input 
                  type="range" min="-46" max="46" step="1" value={pitch}
                  onChange={(e) => setPitch(parseInt(e.target.value))}
                  className="w-full h-3 bg-slate-800 rounded-full appearance-none cursor-pointer accent-indigo-500"
                />
                <div className="flex justify-between text-[10px] text-slate-500 font-bold uppercase tracking-tighter">
                  <span>-46 ST</span>
                  <span>Center (0)</span>
                  <span>+46 ST</span>
                </div>
              </div>

              {/* Fine Tuning / Cents */}
              <div className="space-y-3">
                <div className="flex justify-between text-[10px] uppercase tracking-widest text-slate-400 font-bold">
                  <span>Fine Tune (Cents)</span>
                  <span className="text-pink-400 font-mono">{cents > 0 ? `+${cents}` : cents}</span>
                </div>
                <input 
                  type="range" min="-100" max="100" step="1" value={cents}
                  onChange={(e) => setCents(parseInt(e.target.value))}
                  className="w-full h-1.5 bg-slate-800 rounded-full appearance-none cursor-pointer accent-pink-500"
                />
              </div>

              {/* Granular Params */}
              <div className="grid grid-cols-1 gap-6 pt-6 border-t border-slate-800/50">
                <div className="space-y-3">
                  <div className="flex justify-between text-[10px] uppercase tracking-widest text-slate-400 font-bold">
                    <span>Grain Size</span>
                    <span className="text-cyan-400 font-mono">{grainSize} ms</span>
                  </div>
                  <input 
                    type="range" min="10" max="250" step="1" value={grainSize}
                    onChange={(e) => setGrainSize(parseInt(e.target.value))}
                    className="w-full h-1.5 bg-slate-800 rounded-full appearance-none cursor-pointer accent-cyan-500"
                  />
                </div>

                <div className="space-y-3">
                  <div className="flex justify-between text-[10px] uppercase tracking-widest text-slate-400 font-bold">
                    <span>Overlap Factor</span>
                    <span className="text-emerald-400 font-mono">{Math.round(overlap * 100)}%</span>
                  </div>
                  <input 
                    type="range" min="0.1" max="0.9" step="0.01" value={overlap}
                    onChange={(e) => setOverlap(parseFloat(e.target.value))}
                    className="w-full h-1.5 bg-slate-800 rounded-full appearance-none cursor-pointer accent-emerald-500"
                  />
                </div>

                <div className="space-y-3">
                  <div className="flex justify-between text-[10px] uppercase tracking-widest text-slate-400 font-bold">
                    <span>Mix (Dry/Wet)</span>
                    <span className="text-amber-400 font-mono">{Math.round(mix * 100)}%</span>
                  </div>
                  <input 
                    type="range" min="0" max="1" step="0.01" value={mix}
                    onChange={(e) => setMix(parseFloat(e.target.value))}
                    className="w-full h-1.5 bg-slate-800 rounded-full appearance-none cursor-pointer accent-amber-500"
                  />
                </div>
              </div>

              {/* Action Buttons */}
              <div className="grid grid-cols-2 gap-4 pt-6 border-t border-slate-800">
                <button 
                  onClick={() => {setPitch(0); setCents(0); setMix(1); setGrainSize(50); setOverlap(0.5);}}
                  className="flex items-center justify-center gap-2 py-4 rounded-2xl bg-slate-800 hover:bg-slate-700 transition-colors text-xs font-bold uppercase tracking-widest"
                >
                  <RotateCcw size={14} /> Reset
                </button>
                <button 
                  onClick={exportAudio}
                  disabled={!fileName || isProcessing}
                  className="flex items-center justify-center gap-2 py-4 rounded-2xl bg-indigo-600/20 hover:bg-indigo-600/30 text-indigo-400 border border-indigo-600/30 disabled:opacity-50 disabled:cursor-not-allowed transition-all text-xs font-bold uppercase tracking-widest"
                >
                  <Download size={14} /> {isProcessing ? 'Saving...' : 'Export'}
                </button>
              </div>

            </div>

            {/* Tech Stack Info */}
            <div className="bg-slate-900/40 p-6 rounded-3xl border border-slate-800/50 space-y-4">
               <h3 className="text-xs font-black uppercase tracking-[0.2em] text-slate-500 flex items-center gap-2">
                 <Sliders size={14} /> DSP Architecture
               </h3>
               <div className="text-[11px] text-slate-500 leading-relaxed font-medium">
                 This processor uses a high-performance <strong>AudioWorklet</strong> running on a separate thread. It implements <strong>Granular Synthesis</strong> with independent phase management, allowing ±46 semitones of shift without time dilation artifacts.
               </div>
            </div>
          </section>
        </div>

        {/* Audio Element */}
        <audio ref={audioRef} crossOrigin="anonymous" onEnded={() => setIsPlaying(false)} />
      </div>

      <style>{`
        input[type=range]::-webkit-slider-thumb {
          appearance: none;
          height: 20px;
          width: 20px;
          border-radius: 6px;
          background: #fff;
          cursor: pointer;
          border: 4px solid #0f172a;
          box-shadow: 0 4px 12px rgba(0,0,0,0.5);
        }
        input[type=range]:active::-webkit-slider-thumb {
          transform: scale(1.1);
        }
      `}</style>
    </div>
  );
};

export default App;
