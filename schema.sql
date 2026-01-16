-- users
CREATE TABLE users (
    id SERIAL PRIMARY KEY,
    username text UNIQUE,
    passhash character varying(128),
    passsalt character varying(32)
);

-- songs per user
CREATE TABLE songs (
    id serial PRIMARY KEY,
    title text UNIQUE,
    artist text,
    length integer,
    comment text,
    user_id integer REFERENCES users(id)
);

-- boolean category, can have vals true/false
CREATE TABLE categories_bool (
    id serial PRIMARY KEY,
    name text UNIQUE,
    show boolean,
    user_id integer REFERENCES users(id)
);

CREATE TABLE properties_bool (
    song_id integer REFERENCES songs(id),
    category_id integer REFERENCES categories_bool(id),
    value boolean,
    PRIMARY KEY (song_id, category_id)
);

-- integer category, can have values inside [min,max)
CREATE TABLE categories_num (
    id serial PRIMARY KEY,
    name text UNIQUE,
    show boolean,
    min integer, -- inclusive
    max integer, -- exclusive
    user_id integer REFERENCES users(id)
);

CREATE TABLE properties_num (
    song_id integer REFERENCES songs(id),
    category_id integer REFERENCES categories_num(id),
    value integer,
    PRIMARY KEY (song_id, category_id)
);

CREATE FUNCTION test_category_num(integer, integer)
RETURNS integer AS
$$
    SELECT count(*)
    FROM categories_num
    WHERE id = $1
    AND min <= $2
    AND max > $2;
$$ LANGUAGE SQL;

ALTER TABLE properties_num
ADD CONSTRAINT check_value_num
CHECK (test_category_num(category_id, value) = 1);

-- string, single select, can have value that exists as selectable value
CREATE TABLE categories_string_single (
    id serial PRIMARY KEY,
    name text UNIQUE,
    show boolean,
    user_id integer REFERENCES users(id)
);

CREATE TABLE categories_string_single_values (
    value text UNIQUE,
    category_id integer REFERENCES categories_string_single(id),
    PRIMARY KEY (value, category_id)
);

CREATE TABLE properties_string_single (
    song_id integer REFERENCES songs(id),
    category_id integer REFERENCES categories_string_single(id),
    value text,
    PRIMARY KEY (song_id, category_id)
);

CREATE FUNCTION test_category_string_single(integer, text)
RETURNS integer AS
$$
    SELECT count(*)
    FROM categories_string_single_values
    WHERE category_id = $1
    AND value = $2;
$$ LANGUAGE SQL;

ALTER TABLE properties_string_single
ADD CONSTRAINT check_value_string_single
CHECK (test_category_string_single(category_id, value) = 1);

-- string, single select, can have multiple values that exist as selectable value
CREATE TABLE categories_string_multiple (
    id serial PRIMARY KEY,
    name text UNIQUE,
    show boolean,
    user_id integer REFERENCES users(id)
);

CREATE TABLE categories_string_multiple_values (
    value text,
    category_id integer REFERENCES categories_string_multiple(id)
);

CREATE TABLE properties_string_multiple (
    song_id integer REFERENCES songs(id),
    category_id integer REFERENCES categories_string_multiple(id),
    value text,
    PRIMARY KEY (song_id, category_id, value)
);

CREATE FUNCTION test_category_string_multiple(integer, text)
RETURNS integer AS
$$
    SELECT count(*)
    FROM categories_string_multiple_values
    WHERE category_id = $1
    AND value = $2;
$$ LANGUAGE SQL;

ALTER TABLE properties_string_multiple
ADD CONSTRAINT check_value_string_multiple
CHECK (test_category_string_multiple(category_id, value) = 1);

-- setlists
CREATE TABLE setlists (
    id serial PRIMARY KEY,
    concert_name text,
    break_len integer,
    break_buf integer,
    start time,
    user_id integer REFERENCES users(id)
);

-- ordered songs in encore
CREATE TABLE encore_spot (
    setlist_id integer REFERENCES setlists(id),
    rank double precision,
    song_id integer REFERENCES songs(id),
    PRIMARY KEY (setlist_id, song_id)
);

-- make sure song belongs to same user as setlist
CREATE FUNCTION test_song_id_encore(integer, integer)
RETURNS boolean AS
$$
    SELECT (
        SELECT user_id
        FROM songs
        WHERE id = $1
    ) = (
        SELECT user_id
        FROM setlists
        WHERE id = $2
    );
$$ LANGUAGE SQL;

ALTER TABLE encore_spot
ADD CONSTRAINT check_correct_user_encore
CHECK (test_song_id_encore(song_id, setlist_id));

-- ordered sets in setlist
CREATE TABLE sets (
    id serial PRIMARY KEY,
    rank double precision,
    setlist_id integer REFERENCES setlists(id)
);

-- ordered songs in set
CREATE TABLE set_spot (
    set_id integer REFERENCES sets(id),
    rank double precision,
    song_id integer UNIQUE REFERENCES songs(id),
    PRIMARY KEY (set_id, song_id)
);

-- make sure songs are in setlsit owned by same user
CREATE FUNCTION test_song_id_set(integer, integer)
RETURNS boolean AS
$$
    SELECT (
        SELECT user_id
        FROM songs
        WHERE id = $1
    ) = (
        SELECT user_id
        FROM setlists
        WHERE id = (
            SELECT setlist_id
            FROM sets
            WHERE id = $2
        )
    );
$$ LANGUAGE SQL;

ALTER TABLE set_spot
ADD CONSTRAINT check_correct_user_set
CHECK (test_song_id_set(song_id, set_id));
