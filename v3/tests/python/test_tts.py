from pythos.text_to_speech import split_spoken_chunks


def test_split_spoken_chunks_prefers_sentence_boundaries() -> None:
    chunks = split_spoken_chunks("First sentence. Second sentence.", max_chars=20)

    assert chunks == ["First sentence.", "Second sentence."]


def test_split_spoken_chunks_splits_long_sentences() -> None:
    chunks = split_spoken_chunks("one two three four five", max_chars=10)

    assert chunks == ["one two", "three four", "five"]
