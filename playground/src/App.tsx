import { useState } from 'react';
import SessionList from './components/SessionList';
import ConversationView from './components/ConversationView';
import DiffView from './components/DiffView';
import LiveView from './components/LiveView';
import './styles.css';

type View = 'live' | 'list' | 'session' | 'diff';

export default function App() {
  const [view, setView] = useState<View>('live');
  const [selectedSession, setSelectedSession] = useState<string | null>(null);
  const [diffSessions, setDiffSessions] = useState<[string, string] | null>(null);

  const openSession = (id: string) => {
    setSelectedSession(id);
    setView('session');
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
        <h1 onClick={() => setView('live')}>llm-replay</h1>
        <nav className="nav-tabs">
          <button className={`nav-tab ${view === 'live' ? 'active' : ''}`} onClick={() => setView('live')}>Live</button>
          <button className={`nav-tab ${view === 'list' ? 'active' : ''}`} onClick={() => setView('list')}>Sessions</button>
        </nav>
      </header>

      <main>
        {view === 'live' && <LiveView />}
        {view === 'list' && (
          <SessionList onSelect={openSession} onDiff={openDiff} />
        )}
        {view === 'session' && selectedSession && (
          <ConversationView sessionId={selectedSession} onBack={goBack} onOpenSession={openSession} />
        )}
        {view === 'diff' && diffSessions && (
          <DiffView session1={diffSessions[0]} session2={diffSessions[1]} onBack={goBack} />
        )}
      </main>
    </div>
  );
}
