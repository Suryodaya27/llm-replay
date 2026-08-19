import { useState } from 'react';
import SessionList from './components/SessionList';
import Timeline from './components/Timeline';
import DiffView from './components/DiffView';
import './styles.css';

type View = 'list' | 'timeline' | 'diff';

export default function App() {
  const [view, setView] = useState<View>('list');
  const [selectedSession, setSelectedSession] = useState<string | null>(null);
  const [diffSessions, setDiffSessions] = useState<[string, string] | null>(null);

  const openTimeline = (id: string) => {
    setSelectedSession(id);
    setView('timeline');
  };

  const openDiff = (id1: string, id2: string) => {
    setDiffSessions([id1, id2]);
    setView('diff');
  };

  const goBack = () => {
    setView('list');
    setSelectedSession(null);
    setDiffSessions(null);
  };

  return (
    <div className="app">
      <header className="header">
        <h1 onClick={goBack} style={{ cursor: 'pointer' }}>llm-replay</h1>
        <span className="subtitle">Deterministic Replay Playground</span>
      </header>

      <main className="main">
        {view === 'list' && (
          <SessionList onSelect={openTimeline} onDiff={openDiff} />
        )}
        {view === 'timeline' && selectedSession && (
          <Timeline sessionId={selectedSession} onBack={goBack} onBranchCreated={(newId) => openDiff(selectedSession, newId)} />
        )}
        {view === 'diff' && diffSessions && (
          <DiffView session1={diffSessions[0]} session2={diffSessions[1]} onBack={goBack} />
        )}
      </main>
    </div>
  );
}
