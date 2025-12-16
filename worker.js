// CosmicChat Cloudflare Worker Backend
// Supports: Authentication, Messages, Presence, Profiles, Avatars

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Max-Age': '86400',
};

// Username validation: 4-10 chars, English letters and _, can't start with digit
function isValidUsername(username) {
  const regex = /^[a-zA-Z_][a-zA-Z0-9_]{3,9}$/;
  return regex.test(username);
}

// Helper: JSON Response
function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...CORS_HEADERS,
    },
  });
}

// Helper: Error Response
function errorResponse(message, status = 400) {
  return jsonResponse({ error: message }, status);
}

// Helper: Get user from auth header
async function getAuthUser(request, env) {
  const authHeader = request.headers.get('Authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return null;
  }
  const token = authHeader.slice(7);
  const session = await env.COSMIC_KV.get(`session:${token}`);
  if (!session) return null;
  return JSON.parse(session);
}

// Generate simple token
function generateToken() {
  const array = new Uint8Array(32);
  crypto.getRandomValues(array);
  return Array.from(array, b => b.toString(16).padStart(2, '0')).join('');
}

// Hash password (simple hash for demo - use proper hashing in production)
async function hashPassword(password) {
  const encoder = new TextEncoder();
  const data = encoder.encode(password + 'cosmic_salt_2024');
  const hash = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hash), b => b.toString(16).padStart(2, '0')).join('');
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    // Handle CORS preflight
    if (method === 'OPTIONS') {
      return new Response(null, { headers: CORS_HEADERS });
    }

    try {
      // ==================== AUTH ROUTES ====================
      
      // Register
      if (path === '/api/register' && method === 'POST') {
        const { username, password, nickname } = await request.json();
        
        if (!username || !password) {
          return errorResponse('Username and password required');
        }
        
        const cleanUsername = username.trim().toLowerCase();
        
        // Validate username format
        if (!isValidUsername(cleanUsername)) {
          return errorResponse('Username must be 4-10 characters, English letters and _ only, cannot start with a number');
        }
        
        if (password.length < 4) {
          return errorResponse('Password must be at least 4 characters');
        }
        
        // Check if user exists
        const existingUser = await env.COSMIC_KV.get(`user:${cleanUsername}`);
        if (existingUser) {
          return errorResponse('Username @' + cleanUsername + ' is already taken');
        }
        
        // Create user
        const hashedPassword = await hashPassword(password);
        const user = {
          username: cleanUsername,
          password: hashedPassword,
          nickname: nickname || cleanUsername,
          createdAt: Date.now(),
        };
        
        await env.COSMIC_KV.put(`user:${cleanUsername}`, JSON.stringify(user));
        
        // Create default profile
        const profile = {
          username: cleanUsername,
          nickname: nickname || cleanUsername,
          status: '',
          avatarColor: ['667eea', '764ba2'],
          avatarImage: null,
          createdAt: Date.now(),
        };
        await env.COSMIC_KV.put(`profile:${cleanUsername}`, JSON.stringify(profile));
        
        // Add to users list
        let usersList = JSON.parse(await env.COSMIC_KV.get('users_list') || '[]');
        usersList.push(cleanUsername);
        await env.COSMIC_KV.put('users_list', JSON.stringify(usersList));
        
        // Create session
        const token = generateToken();
        await env.COSMIC_KV.put(`session:${token}`, JSON.stringify({ username: cleanUsername }), { expirationTtl: 86400 * 7 });
        
        return jsonResponse({ success: true, token, username: cleanUsername, profile });
      }
      
      // Login
      if (path === '/api/login' && method === 'POST') {
        const { username, password } = await request.json();
        
        if (!username || !password) {
          return errorResponse('Username and password required');
        }
        
        const cleanUsername = username.trim().toLowerCase();
        const userJson = await env.COSMIC_KV.get(`user:${cleanUsername}`);
        
        if (!userJson) {
          return errorResponse('User not found');
        }
        
        const user = JSON.parse(userJson);
        const hashedPassword = await hashPassword(password);
        
        if (user.password !== hashedPassword) {
          return errorResponse('Incorrect password');
        }
        
        // Create session
        const token = generateToken();
        await env.COSMIC_KV.put(`session:${token}`, JSON.stringify({ username: cleanUsername }), { expirationTtl: 86400 * 7 });
        
        return jsonResponse({ success: true, token, username: cleanUsername });
      }
      
      // Logout
      if (path === '/api/logout' && method === 'POST') {
        const authHeader = request.headers.get('Authorization');
        if (authHeader && authHeader.startsWith('Bearer ')) {
          const token = authHeader.slice(7);
          await env.COSMIC_KV.delete(`session:${token}`);
        }
        return jsonResponse({ success: true });
      }
      
      // Verify token
      if (path === '/api/verify' && method === 'GET') {
        const user = await getAuthUser(request, env);
        if (!user) {
          return errorResponse('Invalid token', 401);
        }
        return jsonResponse({ success: true, username: user.username });
      }
      
      // ==================== USERS ROUTES ====================
      
      // Get all users
      if (path === '/api/users' && method === 'GET') {
        const user = await getAuthUser(request, env);
        if (!user) {
          return errorResponse('Unauthorized', 401);
        }
        
        const usersList = JSON.parse(await env.COSMIC_KV.get('users_list') || '[]');
        const presence = JSON.parse(await env.COSMIC_KV.get('presence') || '{}');
        const now = Date.now();
        
        const users = await Promise.all(usersList
          .filter(u => u !== user.username)
          .map(async (u) => {
            const profileJson = await env.COSMIC_KV.get(`profile:${u}`);
            const profile = profileJson ? JSON.parse(profileJson) : {};
            return {
              username: u,
              nickname: profile.nickname || u,
              avatarColor: profile.avatarColor,
              avatarImage: profile.avatarImage,
              online: presence[u] && (now - presence[u] < 15000),
            };
          }));
        
        return jsonResponse({ users });
      }
      
      // Get user profile
      if (path.startsWith('/api/profile/') && method === 'GET') {
        const user = await getAuthUser(request, env);
        if (!user) {
          return errorResponse('Unauthorized', 401);
        }
        
        const targetUsername = path.split('/api/profile/')[1];
        const profileJson = await env.COSMIC_KV.get(`profile:${targetUsername}`);
        
        if (!profileJson) {
          return errorResponse('User not found', 404);
        }
        
        const profile = JSON.parse(profileJson);
        const presence = JSON.parse(await env.COSMIC_KV.get('presence') || '{}');
        const isOnline = presence[targetUsername] && (Date.now() - presence[targetUsername] < 15000);
        
        return jsonResponse({ 
          profile: {
            ...profile,
            online: isOnline,
            lastSeen: presence[targetUsername] || null
          }
        });
      }
      
      // Update own profile
      if (path === '/api/profile' && method === 'PUT') {
        const user = await getAuthUser(request, env);
        if (!user) {
          return errorResponse('Unauthorized', 401);
        }
        
        const updates = await request.json();
        const profileJson = await env.COSMIC_KV.get(`profile:${user.username}`);
        const profile = profileJson ? JSON.parse(profileJson) : {
          username: user.username,
          createdAt: Date.now(),
        };
        
        // Update allowed fields
        if (updates.nickname !== undefined) profile.nickname = updates.nickname.slice(0, 50);
        if (updates.status !== undefined) profile.status = updates.status.slice(0, 100);
        if (updates.avatarColor !== undefined) profile.avatarColor = updates.avatarColor;
        if (updates.avatarImage !== undefined) {
          // Check size (roughly 5MB in base64)
          if (updates.avatarImage && updates.avatarImage.length > 7000000) {
            return errorResponse('Avatar image too large (max 5MB)');
          }
          profile.avatarImage = updates.avatarImage;
        }
        
        await env.COSMIC_KV.put(`profile:${user.username}`, JSON.stringify(profile));
        
        // Track profile update for sync
        const profileUpdates = JSON.parse(await env.COSMIC_KV.get('profile_updates') || '{}');
        profileUpdates[user.username] = Date.now();
        await env.COSMIC_KV.put('profile_updates', JSON.stringify(profileUpdates));
        
        return jsonResponse({ success: true, profile });
      }
      
      // ==================== PRESENCE ROUTES ====================
      
      // Update presence (heartbeat)
      if (path === '/api/presence' && method === 'POST') {
        const user = await getAuthUser(request, env);
        if (!user) {
          return errorResponse('Unauthorized', 401);
        }
        
        const presence = JSON.parse(await env.COSMIC_KV.get('presence') || '{}');
        presence[user.username] = Date.now();
        
        // Clean old presence (older than 30 seconds)
        const now = Date.now();
        for (const key in presence) {
          if (now - presence[key] > 30000) {
            delete presence[key];
          }
        }
        
        await env.COSMIC_KV.put('presence', JSON.stringify(presence));
        
        return jsonResponse({ success: true, presence });
      }
      
      // Get presence
      if (path === '/api/presence' && method === 'GET') {
        const user = await getAuthUser(request, env);
        if (!user) {
          return errorResponse('Unauthorized', 401);
        }
        
        const presence = JSON.parse(await env.COSMIC_KV.get('presence') || '{}');
        return jsonResponse({ presence });
      }
      
      // ==================== MESSAGES ROUTES ====================
      
      // Send message
      if (path === '/api/messages' && method === 'POST') {
        const user = await getAuthUser(request, env);
        if (!user) {
          return errorResponse('Unauthorized', 401);
        }
        
        const { to, text } = await request.json();
        
        if (!to || !text) {
          return errorResponse('Recipient and text required');
        }
        
        // Check recipient exists
        const recipientExists = await env.COSMIC_KV.get(`user:${to}`);
        if (!recipientExists) {
          return errorResponse('Recipient not found');
        }
        
        const message = {
          id: `${Date.now()}_${generateToken().slice(0, 8)}`,
          from: user.username,
          to: to,
          text: text.trim(),
          timestamp: Date.now(),
          read: false,
        };
        
        // Store message in both users' message lists
        const chatId = [user.username, to].sort().join('_');
        let messages = JSON.parse(await env.COSMIC_KV.get(`chat:${chatId}`) || '[]');
        messages.push(message);
        
        // Keep only last 500 messages per chat
        if (messages.length > 500) {
          messages = messages.slice(-500);
        }
        
        await env.COSMIC_KV.put(`chat:${chatId}`, JSON.stringify(messages));
        
        // Update chat lists for both users
        await updateChatList(env, user.username, to, message);
        await updateChatList(env, to, user.username, message);
        
        return jsonResponse({ success: true, message });
      }
      
      // Get messages with a specific user
      if (path.startsWith('/api/messages/') && method === 'GET') {
        const user = await getAuthUser(request, env);
        if (!user) {
          return errorResponse('Unauthorized', 401);
        }
        
        const otherUser = path.split('/api/messages/')[1];
        const chatId = [user.username, otherUser].sort().join('_');
        const messages = JSON.parse(await env.COSMIC_KV.get(`chat:${chatId}`) || '[]');
        
        // Mark messages as read
        let updated = false;
        messages.forEach(m => {
          if (m.to === user.username && !m.read) {
            m.read = true;
            updated = true;
          }
        });
        
        if (updated) {
          await env.COSMIC_KV.put(`chat:${chatId}`, JSON.stringify(messages));
        }
        
        return jsonResponse({ messages });
      }
      
      // Get all chats
      if (path === '/api/chats' && method === 'GET') {
        const user = await getAuthUser(request, env);
        if (!user) {
          return errorResponse('Unauthorized', 401);
        }
        
        const chatList = JSON.parse(await env.COSMIC_KV.get(`chatlist:${user.username}`) || '[]');
        const presence = JSON.parse(await env.COSMIC_KV.get('presence') || '{}');
        const unreadCounts = JSON.parse(await env.COSMIC_KV.get(`unread:${user.username}`) || '{}');
        const now = Date.now();
        
        // Add online status - unread counts stored separately for efficiency
        const chatsWithStatus = chatList.map(chat => ({
          ...chat,
          online: presence[chat.user] && (now - presence[chat.user] < 20000),
          unread: unreadCounts[chat.user] || 0,
        }));
        
        return jsonResponse({ chats: chatsWithStatus });
      }
      
      // Mark messages as read
      if (path === '/api/messages/read' && method === 'POST') {
        const user = await getAuthUser(request, env);
        if (!user) {
          return errorResponse('Unauthorized', 401);
        }
        
        const { otherUser } = await request.json();
        const chatId = [user.username, otherUser].sort().join('_');
        const messages = JSON.parse(await env.COSMIC_KV.get(`chat:${chatId}`) || '[]');
        
        let updated = false;
        messages.forEach(m => {
          if (m.to === user.username && !m.read) {
            m.read = true;
            updated = true;
          }
        });
        
        if (updated) {
          await env.COSMIC_KV.put(`chat:${chatId}`, JSON.stringify(messages));
        }
        
        // Clear unread count
        const unreadCounts = JSON.parse(await env.COSMIC_KV.get(`unread:${user.username}`) || '{}');
        if (unreadCounts[otherUser]) {
          delete unreadCounts[otherUser];
          await env.COSMIC_KV.put(`unread:${user.username}`, JSON.stringify(unreadCounts));
        }
        
        return jsonResponse({ success: true });
      }
      
      // ==================== POLLING FOR NEW MESSAGES ====================
      
      // Poll for updates (simple polling endpoint)
      if (path === '/api/poll' && method === 'GET') {
        const user = await getAuthUser(request, env);
        if (!user) {
          return errorResponse('Unauthorized', 401);
        }
        
        const since = parseInt(url.searchParams.get('since') || '0');
        const chatWith = url.searchParams.get('with');
        
        let newMessages = [];
        let readUpdates = [];
        
        if (chatWith) {
          const chatId = [user.username, chatWith].sort().join('_');
          const messages = JSON.parse(await env.COSMIC_KV.get(`chat:${chatId}`) || '[]');
          newMessages = messages.filter(m => m.timestamp > since);
          
          // Get read status updates for sent messages
          readUpdates = messages.filter(m => m.from === user.username && m.read).map(m => m.id);
        }
        
        const presence = JSON.parse(await env.COSMIC_KV.get('presence') || '{}');
        
        // Get profile updates since last sync
        const profileUpdates = JSON.parse(await env.COSMIC_KV.get('profile_updates') || '{}');
        const changedProfiles = {};
        for (const username in profileUpdates) {
          if (profileUpdates[username] > since) {
            const p = await env.COSMIC_KV.get(`profile:${username}`);
            if (p) changedProfiles[username] = JSON.parse(p);
          }
        }
        
        return jsonResponse({ 
          messages: newMessages,
          readUpdates,
          presence,
          profileUpdates: changedProfiles,
          timestamp: Date.now()
        });
      }
      
      // ==================== TYPING INDICATOR ====================
      
      // Set typing status
      if (path === '/api/typing' && method === 'POST') {
        const user = await getAuthUser(request, env);
        if (!user) {
          return errorResponse('Unauthorized', 401);
        }
        
        const { to, typing } = await request.json();
        
        const typingData = JSON.parse(await env.COSMIC_KV.get('typing') || '{}');
        const key = `${user.username}_${to}`;
        
        if (typing) {
          typingData[key] = Date.now();
        } else {
          delete typingData[key];
        }
        
        // Clean old typing indicators (older than 5 seconds)
        const now = Date.now();
        for (const k in typingData) {
          if (now - typingData[k] > 5000) {
            delete typingData[k];
          }
        }
        
        await env.COSMIC_KV.put('typing', JSON.stringify(typingData));
        
        return jsonResponse({ success: true });
      }
      
      // Get typing status
      if (path === '/api/typing' && method === 'GET') {
        const user = await getAuthUser(request, env);
        if (!user) {
          return errorResponse('Unauthorized', 401);
        }
        
        const from = url.searchParams.get('from');
        const typingData = JSON.parse(await env.COSMIC_KV.get('typing') || '{}');
        const key = `${from}_${user.username}`;
        
        const isTyping = typingData[key] && (Date.now() - typingData[key] < 5000);
        
        return jsonResponse({ typing: isTyping });
      }
      
      // Default: Not found
      return errorResponse('Not found', 404);
      
    } catch (error) {
      console.error('Error:', error);
      return errorResponse('Internal server error: ' + error.message, 500);
    }
  },
};

// Helper: Update chat list for a user
async function updateChatList(env, username, otherUser, message) {
  let chatList = JSON.parse(await env.COSMIC_KV.get(`chatlist:${username}`) || '[]');
  
  // Remove existing entry for this user
  chatList = chatList.filter(c => c.user !== otherUser);
  
  // Add to top
  chatList.unshift({
    user: otherUser,
    lastMessage: message.text,
    timestamp: message.timestamp,
  });
  
  // Keep only 50 chats
  if (chatList.length > 50) {
    chatList = chatList.slice(0, 50);
  }
  
  await env.COSMIC_KV.put(`chatlist:${username}`, JSON.stringify(chatList));
  
  // Update unread count for recipient (not sender)
  if (message.to === username) {
    const unreadCounts = JSON.parse(await env.COSMIC_KV.get(`unread:${username}`) || '{}');
    unreadCounts[otherUser] = (unreadCounts[otherUser] || 0) + 1;
    await env.COSMIC_KV.put(`unread:${username}`, JSON.stringify(unreadCounts));
  }
}
