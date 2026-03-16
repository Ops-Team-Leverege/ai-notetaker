import React from 'react';
import { Navigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';

export function Login() {
    const { user, loading, login } = useAuth();

    if (loading) {
        return <div className="loading">Loading...</div>;
    }

    if (user) {
        return <Navigate to="/" replace />;
    }

    return (
        <div className="login-container">
            <h1>Meeting Notetaker</h1>
            <p>Sign in to access your meeting transcripts</p>
            <button onClick={login} className="login-button">
                Sign in with Google
            </button>
        </div>
    );
}
