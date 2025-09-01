require('dotenv').config()
const express = require('express')
const app = express()
const http = require('http')
const server = http.createServer(app)
const { Server } = require('socket.io')
const io = new Server(server)
const proxy = require('express-http-proxy')
const jwt = require('jsonwebtoken')
const crypt = require('crypto')
const pgp = require('pg-promise')()
const db = pgp(process.env.DBURL)
const bodyparser = require('body-parser')
const uuid = require('uuid').v4

app.use(bodyparser.urlencoded({ extended: false }))
app.use(bodyparser.json())

app.get("/ping", (req, res) => {
    res.send("pong")
})

const DEFAULT_REPERTOIRE = { categories: [], songs: [] }
const DEFAULT_SETLIST = { concert: 'new setlist', sets: [], encore: [], breaks: { len: 20, buffer: 5 }, startTime: '19:30', timeFixed: 'start' }

app.post('/api/signup', async (req, res) => {
    const password = req.body?.password
    const username = req.body?.username?.toLowerCase()
    if (!password || !username) {
        res.status(400)
        res.json({ 'status': 'error', 'error': 'missing request body' })
        return
    }
    const userExists = (await db.one('SELECT count(*) FROM public.users WHERE username = $1', [username])).count > 0
    if (userExists) {
        res.status(400)
        res.json({ 'status': 'error', 'error': 'user exists already' })
        return
    }
    const salt = crypt.randomBytes(16).toString('hex')
    const hash = crypt.createHash('sha512').update(password).update(salt).digest().toString('hex')
    db.none('INSERT INTO public.users VALUES (DEFAULT, $1, $2, $3, $4);', [username, hash, salt, JSON.stringify(DEFAULT_REPERTOIRE)]).then(() => {
        res.status(200)
        res.json(generateToken(username))
    }).catch(() => {
        res.status(500)
        res.json({ 'status': 'error', 'error': 'internal server error' })
    });
})

app.post('/api/login', async (req, res) => {
    const password = req.body?.password
    const username = req.body?.username?.toLowerCase()
    if (!password || !username) {
        res.status(400)
        return
    }
    const vals = (await db.any('SELECT (passhash, passsalt) FROM public.users WHERE username = $1;', username))?.[0]?.row
    if (!vals) {
        res.sendStatus(400)
        return
    }
    const [hash, salt] = vals.substring(1, vals.length - 1).split(',')
    const testHash = crypt.createHash('sha512').update(password).update(salt).digest().toString('hex')
    if (hash !== testHash) {
        res.sendStatus(403)
        return
    }
    res.status(200)
    res.json(generateToken(username))
})

app.get('/api/pinguser', authenticateToken, (req, res) => {
    res.status(200)
    res.send(req.user)
})

app.get('/api/repertoire', authenticateToken, async (req, res) => {
    const repertoire = (await db.any('SELECT repertoire FROM public.users WHERE username = $1;', [req.user]))?.[0]?.repertoire || DEFAULT_REPERTOIRE
    res.status(200)
    res.json(repertoire)
})

app.post('/api/repertoire', authenticateToken, async (req, res) => {
    const repertoire = req.body
    db.none('UPDATE public.users SET repertoire = $1 WHERE username = $2;', [JSON.stringify(repertoire), req.user]).then(() => {
        res.sendStatus(200)
    }).catch((err) => {
        console.log(err)
        res.sendStatus(400)
    })
})

io.on('connection', async socket => {
    console.log('user connected to socket')
    const token = socket.handshake.headers?.token
    if (!token) return

    const username = validateToken(token).username

    console.log(username)
    socket.join(username)

    socket.on('repertoire', newRepertoire => {
        console.log('repertoire edit')
        db.none('UPDATE public.users SET repertoire = $1 WHERE username = $2;', [JSON.stringify(newRepertoire), username])
        io.to(username).emit('repertoire', newRepertoire)
    })

    socket.on('setlist', newSetlist => {
        console.log('setlist edit on', newSetlist.id)
        db.none('UPDATE public.setlists SET data = $1, concert = $2 WHERE userid = (SELECT id FROM public.users WHERE username = $3) AND id = $4', [newSetlist.data, newSetlist.data.concert, username, newSetlist.id])
        io.to(username).emit('setlist', newSetlist)
    })

    socket.on('setlists', async () => {
        const setlists = await db.any('SELECT id, concert FROM public.setlists WHERE userid = (SELECT id FROM public.users WHERE username = $1);', [username])
        io.to(username).emit('setlists', setlists)
    })

    socket.on('disconnect', () => {
        console.log('user disconnected from socket')
    })
})

app.get('/api/setlists', authenticateToken, async (req, res) => {
    const setlists = await db.any('SELECT id, concert FROM public.setlists WHERE userid = (SELECT id FROM public.users WHERE username = $1);', [req.user])
    res.status(200)
    res.json(setlists)
})

app.get('/api/setlist/:id', authenticateToken, async (req, res) => {
    const setlist = (await db.one('SELECT data FROM public.setlists WHERE userid = (SELECT id FROM public.users WHERE username = $1) AND id = $2;', [req.user, req.params.id]))?.data
    res.status(200)
    res.json(setlist)
})

app.post('/api/setlist/:id', authenticateToken, async (req, res) => {
    const setlist = req.body
    if (!setlist.concert) {
        return res.sendStatus(400)
    }
    await db.none('UPDATE public.setlists SET data = $1, concert = $2 WHERE userid = (SELECT id FROM public.users WHERE username = $3) AND id = $4;', [JSON.stringify(setlist), setlist.concert, req.user, req.params.id])
    res.sendStatus(200)
})

app.delete('/api/setlist/:id', authenticateToken, async (req, res) => {
    await db.none('DELETE FROM public.setlists WHERE userid = (SELECT id FROM public.users WHERE username = $1) AND id = $2;', [req.user, req.params.id])
    res.sendStatus(200)
})

app.post('/api/setlist', authenticateToken, async (req, res) => {
    const newID = uuid()
    await db.none('INSERT INTO public.setlists VALUES ( (SELECT id FROM public.users WHERE username = $1), $2, $3, $4);', [req.user, newID, 'new setlist', JSON.stringify(DEFAULT_SETLIST)])
    res.status(200)
    res.send(newID)
})

function generateToken(username) {
    return jwt.sign({ 'username': username }, process.env.KEY, { expiresIn: '365d' })
}

function validateToken(token) {
    return jwt.verify(token, process.env.KEY)
}

function authenticateToken(req, res, next) {
    const token = req.headers['authorization']?.split(' ')[1]
    if (!token) {
        return res.sendStatus(401)
    }

    jwt.verify(token, process.env.KEY, (err, user) => {
        if (err) return res.sendStatus(403)

        req.user = user.username

        next()
    })
}

app.use(express.static('/acme', { dotfiles: 'allow' }))

app.use('/', proxy('localhost:3000/'))

const PORT = process.env.PORT || 8080
db.connect().then(() => {
    server.listen(PORT, () => {
        console.log(`server listening on port ${PORT}`)
        console.log(`http://localhost:${PORT}`)
        db.one('SELECT count(username) FROM public.users;').then((data) => { console.log(data.count, 'users loaded in db') })
    })
})
