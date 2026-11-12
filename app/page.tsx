'use client';

import dynamic from 'next/dynamic';
import { useState, useEffect } from 'react';
import { Folder, Plus, Edit2, Trash2, Check, X, ArrowRight } from 'lucide-react';
import Link from 'next/link';
import { readJson } from '@/lib/read-json';

const MindMap = dynamic(() => import('@/components/MindMap'), { ssr: false });

// Small icon buttons with a finger-sized hit area
const iconButton = (color: string): React.CSSProperties => ({
  background: 'none', border: 'none', color, cursor: 'pointer',
  minWidth: '36px', minHeight: '36px', display: 'flex', alignItems: 'center', justifyContent: 'center',
});

// The last course opened on this device, to reopen it next time
const LAST_COURSE_KEY = 'lastCourse';
const readLastCourse = () => {
  try { return localStorage.getItem(LAST_COURSE_KEY); } catch { return null; }
};

export default function Home() {
  const [courses, setCourses] = useState<string[]>([]);
  // Empty until the course list loads, so no map is opened for a course we're about to switch away from
  const [currentCourse, setCurrentCourse] = useState<string>('');
  const [coursesLoaded, setCoursesLoaded] = useState(false);
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  
  const [isCreating, setIsCreating] = useState(false);
  const [newCourseName, setNewCourseName] = useState('');
  
  const [editingCourse, setEditingCourse] = useState<string | null>(null);
  const [editName, setEditName] = useState('');

  useEffect(() => {
    fetchCourses();
  }, []);

  useEffect(() => {
    if (!currentCourse) return;
    try { localStorage.setItem(LAST_COURSE_KEY, currentCourse); } catch {}
  }, [currentCourse]);

  const fetchCourses = async () => {
    try {
      const res = await fetch('/api/courses');
      const data = await readJson(res, 'Loading the courses');
      if (data.courses) {
        setCourses(data.courses);
        const lastCourse = readLastCourse();
        if (lastCourse && data.courses.includes(lastCourse)) {
          setCurrentCourse(lastCourse);
        } else if (data.courses.length > 0) {
          setCurrentCourse(data.courses[0]);
        }
      }
    } catch (err) {
      console.error('Failed to fetch courses', err);
    } finally {
      setCoursesLoaded(true);
    }
  };

  const handleCreate = async () => {
    if (!newCourseName.trim()) return;
    try {
      const res = await fetch('/api/courses', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'create', courseName: newCourseName })
      });
      if (res.ok) {
        setCourses([...courses, newCourseName]);
        setCurrentCourse(newCourseName);
        setIsCreating(false);
        setNewCourseName('');
      } else {
        const data = await readJson(res, 'Saving the course').catch(() => ({}));
        alert(data.error || 'Failed to create course');
      }
    } catch (err) {
      console.error(err);
    }
  };

  const handleRename = async (oldName: string) => {
    if (!editName.trim() || editName === oldName) {
      setEditingCourse(null);
      return;
    }
    try {
      const res = await fetch('/api/courses', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'rename', courseName: oldName, newCourseName: editName })
      });
      if (res.ok) {
        setCourses(courses.map(c => c === oldName ? editName : c));
        if (currentCourse === oldName) setCurrentCourse(editName);
        setEditingCourse(null);
      } else {
        const data = await readJson(res, 'Saving the course').catch(() => ({}));
        alert(data.error || 'Failed to rename course');
      }
    } catch (err) {
      console.error(err);
    }
  };

  const handleDelete = async (course: string) => {
    if (!confirm(`Are you sure you want to delete "${course}"?`)) return;
    try {
      const res = await fetch('/api/courses', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'delete', courseName: course })
      });
      if (res.ok) {
        const updated = courses.filter(c => c !== course);
        setCourses(updated);
        if (currentCourse === course) {
          setCurrentCourse(updated.length > 0 ? updated[0] : '');
        }
      }
    } catch (err) {
      console.error(err);
    }
  };

  return (
    <main style={{ width: '100%', height: '100%', display: 'flex', flexDirection: 'column' }}>
      <div style={{ 
        minHeight: '50px',
        boxSizing: 'content-box',
        // Clear the status bar / rounded corners when opened from the iPad home screen
        paddingTop: 'env(safe-area-inset-top)',
        paddingLeft: 'max(20px, env(safe-area-inset-left))',
        paddingRight: 'max(20px, env(safe-area-inset-right))',
        flexShrink: 0,
        background: '#1e293b', 
        borderBottom: '1px solid #334155', 
        display: 'flex', 
        alignItems: 'center', 
        color: 'white',
        zIndex: 50,
        justifyContent: 'space-between'
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', position: 'relative' }}>
          <Folder size={20} color="#3b82f6" />
          <span style={{ fontWeight: 'bold', maxWidth: '40vw', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{currentCourse || (coursesLoaded ? 'No Course Selected' : '')}</span>
          
          <button 
            onClick={() => setIsMenuOpen(!isMenuOpen)}
            style={{ marginLeft: '10px', background: '#334155', border: 'none', color: 'white', padding: '0 12px', minHeight: '36px', borderRadius: '6px', cursor: 'pointer', fontSize: '13px' }}
          >
            Switch Course ▾
          </button>

          {isMenuOpen && (
            // Tap anywhere outside the menu to close it
            <div onClick={() => setIsMenuOpen(false)} style={{ position: 'fixed', inset: 0, zIndex: 99 }} />
          )}

          {isMenuOpen && (
            <div style={{
              zIndex: 100,
              position: 'absolute',
              top: '100%',
              left: 0,
              marginTop: '10px',
              width: 'min(340px, calc(100vw - 40px))',
              background: '#0f172a',
              border: '1px solid #334155',
              borderRadius: '8px',
              boxShadow: '0 10px 15px -3px rgba(0, 0, 0, 0.5)',
              padding: '10px',
              display: 'flex',
              flexDirection: 'column',
              gap: '10px'
            }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '1px solid #334155', paddingBottom: '8px' }}>
                <span style={{ fontWeight: 'bold', fontSize: '14px' }}>My Courses</span>
                <button 
                  onClick={() => setIsCreating(true)}
                  style={{ background: 'none', border: 'none', color: '#10b981', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '4px', fontSize: '13px', minHeight: '36px', padding: '0 8px' }}
                >
                  <Plus size={14} /> New
                </button>
              </div>

              {isCreating && (
                <div style={{ display: 'flex', gap: '4px', alignItems: 'center' }}>
                  <input 
                    autoFocus
                    value={newCourseName}
                    onChange={(e) => setNewCourseName(e.target.value)}
                    placeholder="Course Name..."
                    style={{ flex: 1, padding: '6px', borderRadius: '4px', background: '#1e293b', border: '1px solid #3b82f6', color: 'white', fontSize: '12px' }}
                    onKeyDown={(e) => e.key === 'Enter' && handleCreate()}
                  />
                  <button onClick={handleCreate} style={iconButton('#10b981')}><Check size={16} /></button>
                  <button onClick={() => { setIsCreating(false); setNewCourseName(''); }} style={iconButton('#ef4444')}><X size={16} /></button>
                </div>
              )}

              <div style={{ maxHeight: 'min(400px, 60dvh)', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '4px' }}>
                {courses.length === 0 && <div style={{ color: '#64748b', fontSize: '12px', textAlign: 'center', padding: '10px' }}>No courses found.</div>}
                {courses.map(course => (
                  <div key={course} style={{ display: 'flex', alignItems: 'center', padding: '2px 4px 2px 8px', minHeight: '44px', background: currentCourse === course ? '#1e293b' : 'transparent', borderRadius: '4px' }}>
                    {editingCourse === course ? (
                      <div style={{ display: 'flex', gap: '4px', alignItems: 'center', flex: 1 }}>
                        <input 
                          autoFocus
                          value={editName}
                          onChange={(e) => setEditName(e.target.value)}
                          style={{ flex: 1, padding: '4px', borderRadius: '4px', background: '#0f172a', border: '1px solid #3b82f6', color: 'white', fontSize: '12px' }}
                          onKeyDown={(e) => e.key === 'Enter' && handleRename(course)}
                        />
                        <button onClick={() => handleRename(course)} style={iconButton('#10b981')}><Check size={14} /></button>
                        <button onClick={() => setEditingCourse(null)} style={iconButton('#ef4444')}><X size={14} /></button>
                      </div>
                    ) : (
                      <>
                        <button 
                          onClick={() => { setCurrentCourse(course); setIsMenuOpen(false); }}
                          style={{ flex: 1, alignSelf: 'stretch', textAlign: 'left', background: 'none', border: 'none', color: 'white', cursor: 'pointer', fontSize: '15px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                        >
                          {course}
                        </button>
                        <div style={{ display: 'flex', gap: '4px' }}>
                          <button 
                            onClick={() => { setEditingCourse(course); setEditName(course); }}
                            style={iconButton('#94a3b8')}
                          >
                            <Edit2 size={14} />
                          </button>
                          <button 
                            onClick={() => handleDelete(course)}
                            style={iconButton('#ef4444')}
                          >
                            <Trash2 size={14} />
                          </button>
                        </div>
                      </>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
        

      </div>
      
      <div style={{ flex: 1, position: 'relative' }}>
        {currentCourse ? (
          // key: remount per course so the old course's nodes can never be autosaved into the new one
          <MindMap key={currentCourse} courseName={currentCourse} />
        ) : coursesLoaded && (
          <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '100%', color: 'white', fontSize: '20px' }}>
            Please select or create a course.
          </div>
        )}
      </div>
    </main>
  );
}
