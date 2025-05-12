

const fs = require('fs')
const ejs = require('ejs')
const path = require('path')
const crypto = require('crypto')
const morgan = require('morgan')
const marked = require('marked')
const sqlite3 = require('sqlite3')
const express = require('express')
const session = require('express-session')
const MemoryStore = require('memorystore')(session)


const PASSHASH_PATH = '/data/auth.sha512'
const DATABASE_PATH = '/data/thewall.db'
const SESSION_LENGTH = 1000 * 86400 //24h
const SALT = 'thewall123'
const APP_PORT = 3000


const app = express()
app.set('views', './views')
app.set('view engine', 'ejs')


// Set up the database
const DATABASE_INIT = `
CREATE TABLE posts (
	id INTEGER PRIMARY KEY NOT NULL,
	time INTEGER NOT NULL DEFAULT CURRENT_TIMESTAMP,
	text TEXT NOT NULL CHECK (text != ''),
	mood INTEGER NOT NULL CHECK (mood IN (0, 1, 2, 3, 4)),
	highlight INTEGER NOT NULL CHECK (highlight IN (0, 1)) DEFAULT 0,
STRICT);
`

if (!fs.existsSync(path.dirname(DATABASE_PATH))) {
	console.error('The directory "/data" is not mounted. This is required to store persistent data!')
	process.exit(1)
}

if (!fs.existsSync(DATABASE_PATH)) {
	let db = new sqlite3.Database(DATABASE_PATH)
	db.exec(DATABASE_INIT)
	console.log('New database created')
	db.close()
}

let db = new sqlite3.Database(DATABASE_PATH, sqlite3.OPEN_READWRITE)

let START_DATE = new Date();
db.get("SELECT datetime(time, 'localtime') as time FROM posts LIMIT 1;", (err, row) => {
	if (!(err || row === undefined || row.time === null)) {
		START_DATE = new Date(row.time);
		START_DATE.setDate(1)
		START_DATE.setHours(0, 0, 0, 0)
	}
});


// Set up security
let PASSHASH
if (fs.existsSync(PASSHASH_PATH) === true) {
	PASSHASH = fs.readFileSync(PASSHASH_PATH, 'utf8')
}
const store = new MemoryStore({ 
	checkPeriod: SESSION_LENGTH
})


// Middleware
app.use(morgan('common'))
app.use(express.static('./public'))
app.use(express.urlencoded({ extended: true }))
app.use(session({
	store: store,
	name: 'token',
	secret: 'TgQyYsbBlrFUkqPP9PJxmDAWU6IFegrz2dto0BMtcO2fplWdaCiCNrGxIPjCGYur',
	cookie: { maxAge: SESSION_LENGTH },
	saveUninitialized: false,
	resave: false,
}))


// Enforce password reset on first use
app.use((req, res, next) => {
	if (PASSHASH === undefined && req.path !== '/reset') {
		res.redirect('/reset')
	}
	else {
		next()
	}
})


// Route: /login
app.get('/', (req, res, next) => { res.render('login') })
app.post('/', (req, res, next) => {

	const password = req.body.text
	hash = crypto.createHash('sha512')
		.update(password + SALT)
		.digest('hex')

	if (hash === PASSHASH) {
		console.log('Attempted login: ACCEPTED')
		req.session.regenerate((err) => {
			req.session.authorized = true
			req.session.save((err) => {
				res.redirect('/post')
			})
		})
	}
	else {
		console.log('Attempted login: DENIED')
		res.redirect('/')
	}
})


// Authorize
app.use((req, res, next) => {
	if (PASSHASH === undefined && req.path === '/reset') {
		next()
	}
	else if (req.session.authorized !== true) {
		res.redirect('/')
	}
	else {
		next()
	}
})


// Route: /reset
app.get('/reset', (req, res, next) => { res.render('reset') })
app.post('/reset', (req, res, next) => {

	const new_password = req.body.text

	PASSHASH = crypto.createHash('sha512')
		.update(new_password + SALT)
		.digest('hex')
	fs.writeFileSync(PASSHASH_PATH, PASSHASH)

	store.clear((err) => {
		if (err) {
			console.log(`Error occured when clearing the memorystore: ${err}`)
		}
	})

	res.redirect('/')
})


// Route: /post
app.get('/post', (req, res, next) => {
	res.render('post', { text: '', message: '' })
})

app.post('/post', (req, res, next) => {

	const text      = req.body.text
	const mood      = req.body.mood
	const highlight = (req.body.highlight)? 1: 0

	db.run(
		'INSERT INTO posts (text, mood, highlight) VALUES (?, ?, ?);',
		[text, mood, highlight],
	function(id, err) {
		if (err) {
			console.log(`Error in addPost: ${err.message}`)
			res.render('post', { text: text, message: `Error: ${err.message}` })
		}
		else {
			console.log(`Added new post of ${text.length} characters`)
			res.render('post', { text: '', message: 'Post added successfully.' })
		}
	})
})


// Route: /read
app.get('/read', (req, res, next) => {

	const TODAY = new Date()

	let selectedYear  = Number(req.query.year || new Date().getFullYear())
	let selectedMonth = Number(req.query.month || new Date().getMonth())
	let selectedDate  = new Date(selectedYear, selectedMonth)
	if (selectedDate < START_DATE) { selectedDate = START_DATE }
	if (selectedDate > TODAY)      { selectedDate = TODAY }
	selectedYear  = selectedDate.getFullYear()
	selectedMonth = selectedDate.getMonth()

	const y = selectedDate.getFullYear()
	const m = ('0' + (selectedMonth+1)).slice(-2)
	const d = '01'
	const date = `${y}-${m}-${d}`

	db.all(
		`SELECT id, datetime(time, 'localtime') as time, text, mood, highlight FROM posts
		WHERE time >= DATE(?) AND time < DATE(?, '+1 month');`,
		[date, date],
	function(err, posts) {

		if (err) {
			console.log(`Error occured while fetching posts for ${date}: ${err}`)
			next(err)
		}

		console.log(`Fetched ${posts.length} posts for ${date}`)

		let hl_count = 0
		for (post of posts) {
			post.text = marked.parse(post.text, { breaks: true }).trim()
			if (post.highlight) {
				hl_count += 1
			}
			switch (post.mood) {
				case 0:  post.mood = '😥'; break
				case 1:  post.mood = '🙁'; break
				case 2:  post.mood = '😐'; break
				case 3:  post.mood = '🙂'; break
				case 4:  post.mood = '😁'; break
			}
		}

		res.render('read', {
			minDate: START_DATE,
			maxDate: TODAY,
			selectedYear: selectedYear,
			selectedMonth: selectedMonth,
			posts: posts.reverse(),
			post_count: posts.length,
			hl_count: hl_count,
		})
	})
})


// Route: /highlight
app.patch('/setHighlight/:id/:state', (req, res) => {

	const id = Number(req.params.id)
	const state = Number(req.params.state)

	db.run(
		`UPDATE posts SET highlight=? WHERE id==?;`,
		[state, id],
	function(err) {
		if (err) {
			console.log(`Error in setHighlight: ${err.message}`)
			res.sendStatus(500)
		}
		else {
			console.log(`Updated highlight for post ${id} to ${state}`)
			res.sendStatus(200)
		}
	})
})


// ---
app.use((req, res, next) => {
	res.status(404)
	res.render('void')
})

app.use((err, req, res, next) => {
	console.log(`ERROR OCCURRED: ${err.message}`)
	res.status(err.status || 500)
	res.render('error')
})

app.listen(APP_PORT, () => {
	console.log(`Listening on port ${APP_PORT}`)
})


