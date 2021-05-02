const { DataSource } = require('apollo-datasource');
const {MongoClient, ObjectId} = require('mongodb');
const hangeul = require('../korean/hangeul');
const URI = process.env.MONGO_URL;
const PAGE_COUNT = 20;

class DatabaseAPI extends DataSource {

    constructor() {
        super();
        this.lastFetched = new Date();
        this.lastWOD = null;
    }

    /**
     * This is a function that gets called by ApolloServer when being setup.
     * This function gets called with the datasource config including things
     * like caches and context. We'll assign this.context to the request context
     * here, so we can know about the user making requests
     */
    initialize(config) {
        // noinspection JSUnusedGlobalSymbols
        this.context = config.context;
    }

    async fetchEntries(term){
        const mongo = new MongoClient(URI, { useNewUrlParser: true });
        await mongo.connect();
        let results = await mongo
            .db("hanji")
            .collection("words")
            .find({ term: term })
            .toArray();
        mongo.close();

        let entries = [];
        results.forEach(doc => {
            entries.push(DatabaseAPI.entryReducer(doc));
        });
        return entries;
    }

    async fetchEntry(id) {
        id = this.getSafeID(id);

        const mongo = new MongoClient(URI, { useNewUrlParser: true });
        await mongo.connect();
        let results = await mongo
            .db("hanji")
            .collection("words")
            .find({ _id: id })
            .toArray();
        mongo.close();
        if(results.length > 0) {
            return DatabaseAPI.entryReducer(results[0]);
        } else {
            return  null;
        }
    }

    async fetchExamples(id) {
        id = this.getSafeID(id);

        const mongo = new MongoClient(URI, { useNewUrlParser: true });
        await mongo.connect();
        let results = await mongo
            .db("hanji")
            .collection("words")
            .find({ _id: id }, { projection: { examples: 1 } })
            .toArray();
        mongo.close();

        if(results.length > 0 && results[0].examples) {
            return DatabaseAPI.exampleReducer(results[0].examples);
        } else {
            return  [];
        }
    }

    async searchEnglish(query, cursor) {
        const mongo = new MongoClient(URI, { useNewUrlParser: true });
        await mongo.connect();
        if(!cursor) {
            cursor = 0;
        }

        let array = await mongo
            .db("hanji")
            .collection("words")
            .find({ $text: { $search: query } }, { limit: PAGE_COUNT, skip: cursor})
            .project({ score: { $meta: "textScore" } })
            .sort( { score: { $meta: "textScore" } } )
            .toArray();
        mongo.close();

        let entries = [];
        await array.forEach(entry => {
            entries.push(DatabaseAPI.entryReducer(entry));
        });

        if(entries.length === 0) {
            cursor = -1;
        } else {
            cursor += entries.length;
        }

        return {
            cursor: cursor,
            results: entries
        };
    }

    async fetchWordoftheDay(){
        const mongo = new MongoClient(URI, { useNewUrlParser: true });
        await mongo.connect();
        let hourDiff = Math.abs(new Date() - this.lastFetched) / 36e5;

        if(this.lastWOD == null || hourDiff >= 24) {
            // fetch new Word of the Day
            let result = await mongo
                .db("hanji")
                .collection("words")
                .aggregate([{'$sample': {'size': 1}}])
                .toArray();
            this.lastWOD = result[0];
            this.lastFetched = new Date();
        }

        mongo.close();

        return DatabaseAPI.entryReducer(this.lastWOD)
    }

    async createEntrySuggestion(suggestionData) {
        const entry = await this.fetchEntry(suggestionData.entryID);
        if(!entry) {
            return {
                success: false,
                message: "An entry with the given id doesn't exist"
            }
        }

        const mongo = new MongoClient(URI, { useNewUrlParser: true });
        await mongo.connect();

        const {ops} = await mongo
            .db("hanji")
            .collection("words-suggestions")
            .insertOne({
                entryID: this.getSafeID(suggestionData.entryID),
                antonyms: suggestionData.antonyms?.filter(a => a.length > 0),
                synonyms: suggestionData.synonyms?.filter(s => s.length > 0),
                examples: suggestionData.examples?.filter(e => e.sentence.length > 0 && e.translation.length > 0),
            });
        mongo.close();

        if(ops.length !== 1) {
            return {
                success: false,
                message: "Failed to insert suggestion into database"
            }
        }

        return {
            success: true,
            message: "Entry suggestion successfully created",
            suggestion: DatabaseAPI.entrySuggestionReducer(ops[0])
        }
    }

    async applyEntrySuggestion(id) {
        const mongo = new MongoClient(URI, {useNewUrlParser: true});
        await mongo.connect();

        // Fetch suggestion, check it's not already applied
        const suggestion = await mongo
            .db("hanji")
            .collection("words-suggestions")
            .findOne({_id: this.getSafeID(id)});

        if (suggestion.applied) {
            return {
                success: false,
                message: "This suggestion has already been applied"
            }
        }

        // Update entry based on suggestion
        const updates = {};
        if (suggestion.antonyms) updates.antonym = {$each: suggestion.antonyms};
        if (suggestion.synonyms) updates.synonyms = {$each: suggestion.synonyms};
        if (suggestion.examples) updates.examples = {$each: suggestion.examples};

        const {value: updatedEntry} = await mongo
            .db("hanji")
            .collection("words-staging")
            .findOneAndUpdate(
                {_id: this.getSafeID(suggestion.entryID)},
                {$push: updates},
                {returnOriginal: false}
            );

        if (!updatedEntry) {
            return {
                success: false,
                message: "Failed to insert suggestion into database"
            }
        }

        // Mark suggestion as applied
        const {value: updatedSuggestion} = await mongo
            .db("hanji")
            .collection("words-suggestions")
            .findOneAndUpdate(
                {_id: this.getSafeID(id)},
                {$set: {applied: true}},
                {returnOriginal: false}
            );

        mongo.close();
        return {
            success: true,
            message: "Entry suggestion successfully applied",
            entry: DatabaseAPI.entryReducer(updatedEntry),
            suggestion: DatabaseAPI.entrySuggestionReducer(updatedSuggestion),
        }
    }

    async editEntrySuggestion(id, suggestionData) {
        const mongo = new MongoClient(URI, {useNewUrlParser: true});
        await mongo.connect();

        const {value: updatedSuggestion} = await mongo
            .db("hanji")
            .collection("words-suggestions")
            .findOneAndUpdate(
                {_id: this.getSafeID(id)},
                {$set: suggestionData},
                {returnOriginal: false}
            );

        if (!updatedSuggestion) {
            return {
                success: false,
                message: "Failed to edit suggestion"
            }
        }

        return {
            success: true,
            message: "Successfully edited suggestion",
            suggestion: DatabaseAPI.entrySuggestionReducer(updatedSuggestion)
        }
    }

    async fetchEntrySuggestions() {
        const mongo = new MongoClient(URI, { useNewUrlParser: true });
        await mongo.connect();

        const array = await mongo
            .db("hanji")
            .collection("words-suggestions")
            .find()
            .toArray();
        mongo.close();

        return array.map(a => DatabaseAPI.entrySuggestionReducer(a));
    }

    async fetchEntrySuggestion(id) {
        const mongo = new MongoClient(URI, { useNewUrlParser: true });
        await mongo.connect();

        const array = await mongo
            .db("hanji")
            .collection("words-suggestions")
            .find({_id: this.getSafeID(id)})
            .toArray();
        mongo.close();

        return array.length > 0 ? DatabaseAPI.entrySuggestionReducer(array[0]) : null;
    }

    static exampleReducer(examples){
        let reducedExamples = [];
        examples.forEach(example => {
            reducedExamples.push({
                sentence: example.sentence,
                translation: example.translation
            });
        });
        return reducedExamples;
    }

    static entryReducer(entry){
        let data = {
            id: entry._id.toString(),
            term: entry.term,
            pos: entry.pos,
            definitions: entry.definitions
        };
        if(entry.examples) {
            data.examples = DatabaseAPI.exampleReducer(entry.examples)
        }
        if(entry.antonyms) {
            data.antonyms = entry.antonyms;
        }
        if(entry.synonyms){
            data.synonyms = entry.synonyms;
        }
        if(entry.regular) {
            data.regular = entry.regular;
        }
        if(entry.note) {
            data.note = entry.note;
        }

        return data;
    }

    static entrySuggestionReducer(entrySuggestion) {
        const {_id, entryID, applied, ...rest} = entrySuggestion;
        return {
            id: _id.toString(),
            entryID: entryID.toString(),
            applied: !!applied,
            ...rest
        };
    }

    static containsHangul(string) {
        for(let i = 0;i<string.length;i++){
            if (hangeul.is_hangeul(string[i])) {
               return true;
            }
        }
        return false;
    }

    getSafeID(id) {
        // Check if id is ObjectID or old form
        if (!DatabaseAPI.containsHangul(id)) {
            id = new ObjectId(id);
        }
        return id;
    }
}
module.exports = DatabaseAPI;